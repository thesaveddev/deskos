import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import type { AuthenticatorTransportFuture, WebAuthnCredential } from '@simplewebauthn/server'
import { verifyPassword } from '../../core/auth/password.js'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { auditLoginAcrossTenants, issueTokens, recordAuthAttempt } from './auth.routes.js'
import {
  buildAuthenticationOptions,
  buildRegistrationOptions,
  consumeChallenge,
  createWebauthnVerifier,
  storeChallenge,
  type WebauthnVerifier,
} from './webauthn.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable verifier for tests; falls back to the real SimpleWebAuthn verifier. */
    webauthnVerifier?: WebauthnVerifier
  }
}

const registerCompleteSchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
  deviceName: z.string().max(120).optional(),
})

const assertBeginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
})

const assertCompleteSchema = z.object({
  challengeId: z.string().min(1),
  response: z.unknown(),
})

export async function webauthnRoutes(app: FastifyInstance): Promise<void> {
  const verifierFor = () => app.webauthnVerifier ?? createWebauthnVerifier(app.config)

  app.post('/auth/webauthn/register/begin', { preHandler: [authenticate] }, async (request) => {
    const user = request.user!
    const { rows } = await app.db.query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [user.id])
    const exclude = rows.map((r: { credential_id: string; transports: string[] }) => ({ id: r.credential_id, transports: r.transports as AuthenticatorTransportFuture[] | undefined }))
    const { options, challenge } = await buildRegistrationOptions(app.config, user.email, new TextEncoder().encode(user.id), exclude)
    return { challengeId: storeChallenge(user.id, challenge), options }
  })

  app.post('/auth/webauthn/register/complete', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.user!
    const body = registerCompleteSchema.parse(request.body)
    const { challenge, userId } = consumeChallenge(body.challengeId)
    if (userId !== user.id) throw AppError.badRequest('Passkey challenge does not belong to this user', 'webauthn_challenge_mismatch')
    const info = await verifierFor().verifyRegistration(body.response, challenge)
    const { rows } = await app.db.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, device_name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, device_name, created_at`,
      [user.id, info.credentialId, Buffer.from(info.publicKey), info.counter, info.transports ?? [], body.deviceName ?? ''],
    )
    await app.db.query('UPDATE users SET webauthn_enabled = true WHERE id = $1', [user.id])
    return reply.code(201).send({ credential: rows[0] })
  })

  app.post('/auth/webauthn/assert/begin', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = assertBeginSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT id, email, password_hash, status FROM users WHERE email = $1', [body.email])
    const user = rows[0]
    const passwordOk = user?.password_hash ? await verifyPassword(body.password, user.password_hash) : false
    if (!user || user.status !== 'active' || !passwordOk) {
      await recordAuthAttempt(app, body.email, request.ip, false, 'invalid_credentials')
      throw AppError.unauthorized('Invalid email or password', 'invalid_credentials')
    }
    const creds = await app.db.query('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = $1', [user.id])
    if (creds.rowCount === 0) return { available: false }
    const allow = creds.rows.map((r: { credential_id: string; transports: string[] }) => ({ id: r.credential_id, transports: r.transports as AuthenticatorTransportFuture[] | undefined }))
    const { options, challenge } = await buildAuthenticationOptions(app.config, allow)
    return { available: true, challengeId: storeChallenge(user.id, challenge), options }
  })

  app.post('/auth/webauthn/assert/complete', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = assertCompleteSchema.parse(request.body)
    const { challenge, userId } = consumeChallenge(body.challengeId)
    const userRes = await app.db.query('SELECT id, email, name, status FROM users WHERE id = $1', [userId])
    const user = userRes.rows[0]
    if (!user || user.status !== 'active') throw AppError.unauthorized('Account not found')

    const responseId = (body.response as { id?: string })?.id
    const credRes = await app.db.query(
      'SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2',
      [userId, responseId ?? ''],
    )
    const cred = credRes.rows[0]
    if (!cred) {
      await recordAuthAttempt(app, user.email, request.ip, false, 'webauthn_unknown_credential')
      throw AppError.unauthorized('Unknown passkey', 'webauthn_unknown_credential')
    }
    const credential: WebAuthnCredential = {
      id: cred.credential_id,
      publicKey: new Uint8Array(cred.public_key as ArrayBuffer),
      counter: Number(cred.counter),
      transports: cred.transports ?? undefined,
    }
    const info = await verifierFor().verifyAuthentication(body.response, challenge, credential)
    await app.db.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = now() WHERE credential_id = $2 AND user_id = $3',
      [info.newCounter, cred.credential_id, userId],
    )
    await recordAuthAttempt(app, user.email, request.ip, true)
    await auditLoginAcrossTenants(app, userId, request.ip, request.headers['user-agent'])
    const tokens = await issueTokens(app, userId)
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens }
  })

  app.get('/auth/webauthn/credentials', { preHandler: [authenticate] }, async (request) => {
    const { rows } = await app.db.query(
      'SELECT id, device_name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at',
      [request.user!.id],
    )
    return { credentials: rows }
  })

  app.delete('/auth/webauthn/credentials/:id', { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string }
    const { rows } = await app.db.query('DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id', [id, request.user!.id])
    if (!rows[0]) throw AppError.notFound('Passkey not found')
    const remaining = await app.db.query('SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1', [request.user!.id])
    if (remaining.rowCount === 0) await app.db.query('UPDATE users SET webauthn_enabled = false WHERE id = $1', [request.user!.id])
    return { ok: true }
  })
}
