import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { roleHasPermission } from '../../core/permissions.js'
import { withTenant, type DbPool } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { generateEnrolCode, hashToken } from '../devices/device-auth.js'
import { authenticateAgent } from '../devices/device-auth.js'
import { assertSessionPermission, issueJoinToken, sessionPermissions } from './remote.routes.js'
import { buildIceServers } from '../../core/ice.js'
import '../../types.js'

const createSchema = z.object({
  permissions: z.array(z.enum(sessionPermissions)).min(1).max(10).default(['view_screen']),
  reason: z.string().trim().max(500).optional(),
  expiresInMin: z.number().int().min(1).max(1440).optional(),
  codeLength: z.literal(12).default(12),
})

const emailSchema = z.object({
  to: z.string().email().max(320),
  code: z.string().regex(/^\d{12}$/),
  mode: z.enum(['code', 'email_link']).default('email_link'),
})

// Older links remain readable for compatibility; new support sessions default
// to the stronger 12-digit code.
const publicCodeSchema = z.string().regex(/^\d{12}$/)

const claimSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  hostname: z.string().min(1).max(255).optional(),
  os: z.string().max(40).optional(),
  osVersion: z.string().max(80).optional(),
  arch: z.string().max(40).optional(),
})

const consentSchema = z.object({
  granted: z.boolean(),
  permissions: z.array(z.enum(sessionPermissions)).min(1).max(10).optional(),
})
const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) })

const LIVE_SESSION_STATES = new Set<string>(['requested', 'consent_pending', 'connecting', 'active', 'reconnecting'])

type ClientPlatform = 'windows' | 'macos' | 'linux' | 'ios' | 'ipados' | 'android' | 'unknown'

function clientPlatform(request: { headers: Record<string, string | string[] | undefined> }): ClientPlatform {
  const userAgent = String(request.headers['user-agent'] ?? '').toLowerCase()
  if (/iphone/.test(userAgent)) return 'ios'
  if (/ipad/.test(userAgent)) return 'ipados'
  if (/android/.test(userAgent)) return 'android'
  if (/macintosh|mac os x/.test(userAgent)) return 'macos'
  if (/windows/.test(userAgent)) return 'windows'
  if (/linux/.test(userAgent)) return 'linux'
  return 'unknown'
}

interface AdhocRow {
  id: string
  tenant_id: string
  state: string
  permissions: string[]
  reason: string
  requested_by: string
  device_id: string | null
  remote_session_id: string | null
  expires_at: Date
  claim_mode: 'code' | 'email_link'
  claim_token_hash: string | null
  claim_token_used_at: Date | null
  claim_fingerprint_hash: string | null
}

/** Pre-tenant lookup by code hash, mirroring the device-token read path. */
async function findAdhocByCode(pool: DbPool, code: string): Promise<AdhocRow | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const codeHash = hashToken(code)
    await client.query("SELECT set_config('app.adhoc_code_hash', $1, true)", [codeHash])
    const { rows } = await client.query(
      `SELECT id, tenant_id, state, permissions, reason, requested_by,
              device_id, remote_session_id, expires_at, claim_mode,
              claim_token_hash, claim_token_used_at, claim_fingerprint_hash
         FROM adhoc_sessions
        WHERE code_hash = $1
        LIMIT 1`,
      [codeHash],
    )
    await client.query('COMMIT')
    return rows[0] as AdhocRow | undefined
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    throw err
  } finally {
    client.release()
  }
}

function publicAdhoc(
  row: AdhocRow,
  helperAvailable: boolean,
  macHelperAvailable: boolean,
  androidHelperAvailable: boolean,
  platform: ClientPlatform,
  sessionState?: string,
): { state: string; sessionState?: string; reason: string; permissions: string[]; helperAvailable: boolean; macHelperAvailable: boolean; androidHelperAvailable: boolean; platform: ClientPlatform; helperSupported: boolean; claimMode: string; sessionId?: string } {
  return {
    state: row.state,
    ...(sessionState ? { sessionState } : {}),
    reason: row.reason,
    permissions: row.permissions,
    helperAvailable,
    macHelperAvailable,
    androidHelperAvailable,
    platform,
    helperSupported: platform === 'windows' ? helperAvailable : platform === 'macos' ? macHelperAvailable : platform === 'android' ? androidHelperAvailable : false,
    claimMode: row.claim_mode,
    ...(row.remote_session_id ? { sessionId: row.remote_session_id } : {}),
  }
}

function newClaimToken(): string {
  return `reydesk_link_${randomBytes(32).toString('base64url')}`
}

function claimFingerprint(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  const value = request.headers['x-reydesk-claim-fingerprint'] ?? request.headers['x-deskos-claim-fingerprint']
  if (Array.isArray(value)) return null
  const fingerprint = value?.trim()
  return fingerprint && fingerprint.length <= 300 ? fingerprint : null
}

/** Technician-facing route (registered under /api/v1). */
export async function adhocSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/adhoc-sessions', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    assertSessionPermission(ctx.orgRole, 'attended', body.permissions, body.reason)

    const tenantRow = (await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0]
    const remoteDefaults = (tenantRow?.settings?.remote_support ?? {}) as Record<string, unknown>
    const expiresInMin = Number(body.expiresInMin ?? remoteDefaults.default_expiry_minutes ?? 30)
    const code = generateEnrolCode(body.codeLength)
    const expiresAt = new Date(Date.now() + expiresInMin * 60_000)
    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO adhoc_sessions (tenant_id, code_hash, permissions, reason, requested_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, permissions, reason, state, expires_at`,
        [ctx.tenantId, hashToken(code), body.permissions, body.reason ?? '', request.user!.id, expiresAt],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'session.adhoc.created',
        objectType: 'adhoc_session',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { permissions: body.permissions, codeLength: body.codeLength, claimMode: 'code' },
      })
      return res.rows[0]
    })

    return reply.code(201).send({
      id: created.id,
      code,
      connectUrl: `${app.config.publicUrl}/connect/${code}`,
      expiresAt: created.expires_at,
      codeLength: code.length,
      claimMode: 'code',
    })
  })

  app.post('/adhoc-sessions/:id/email', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) {
      throw AppError.forbidden('Missing permission: remote.attended', 'missing_permission')
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const body = emailSchema.parse(request.body)
    const row = await findAdhocByCode(app.db, body.code)
    if (!row || row.id !== id || row.tenant_id !== ctx.tenantId || row.requested_by !== request.user!.id || row.state !== 'open' || new Date(row.expires_at).getTime() <= Date.now()) {
      throw AppError.notFound('This support code is invalid or expired.')
    }
    const claimToken = body.mode === 'email_link' ? newClaimToken() : null
    await withTenant(app.db, ctx.tenantId, (client) => client.query(
      `UPDATE adhoc_sessions
          SET claim_mode = $2,
              claim_token_hash = $3,
              claim_token_used_at = NULL,
              claim_fingerprint_hash = NULL,
              updated_at = now()
        WHERE id = $1 AND state = 'open'`,
      [id, body.mode, claimToken ? hashToken(claimToken) : null],
    ))
    const connectUrl = claimToken
      ? `${app.config.publicUrl}/connect/${body.code}?claimToken=${encodeURIComponent(claimToken)}`
      : `${app.config.publicUrl}/connect/${body.code}`
    const message = app.mailer.buildRemoteSupportMail({
      to: body.to,
      connectUrl,
      code: body.code,
      mode: body.mode,
    })
    const jobId = app.emailQueue.add(message)
    await withTenant(app.db, ctx.tenantId, (client) => recordAudit(client, ctx.tenantId, {
      actorType: 'user',
      actorId: request.user!.id,
      action: 'session.adhoc.email_queued',
      objectType: 'adhoc_session',
      objectId: id,
      ip: request.ip,
      payload: { recipient: body.to, jobId, mode: body.mode },
    }))
    return reply.code(202).send({ ok: true, jobId, mode: body.mode })
  })

  app.get('/adhoc-sessions', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) {
      throw AppError.forbidden('Missing permission: remote.attended', 'missing_permission')
    }
    const result = await withTenant(app.db, ctx.tenantId, (client) =>
      client.query(
        `SELECT a.id, a.state, a.permissions, a.reason, a.expires_at, a.claimed_at, a.created_at,
                d.name AS device_name, a.remote_session_id, rs.state AS remote_session_state
           FROM adhoc_sessions a
           LEFT JOIN devices d ON d.id = a.device_id
           LEFT JOIN remote_sessions rs ON rs.id = a.remote_session_id
          ORDER BY a.created_at DESC
          LIMIT 100`,
      ),
    )
    return reply.send({ sessions: result.rows })
  })

  app.post('/adhoc-sessions/:id/revoke', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) {
      throw AppError.forbidden('Missing permission: remote.attended', 'missing_permission')
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const revoked = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE adhoc_sessions
            SET state = 'expired', updated_at = now()
          WHERE id = $1 AND state = 'open'
          RETURNING id, state`,
        [id],
      )
      if (!res.rowCount) return null
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'session.adhoc.revoked',
        objectType: 'adhoc_session',
        objectId: id,
        ip: request.ip,
      })
      return res.rows[0]
    })
    if (!revoked) throw AppError.conflict('This support code is not open and cannot be revoked.', 'not_open')
    return reply.send({ id: revoked.id, state: revoked.state })
  })
}

/** Public routes (registered at the root, no tenant auth). */
export async function connectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/connect/:code', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { code: rawCode } = request.params as { code: string }
    const codeResult = publicCodeSchema.safeParse(rawCode)
    if (!codeResult.success) return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    const code = codeResult.data
    const query = request.query as { claimToken?: string }
    const claimToken = typeof query.claimToken === 'string' ? query.claimToken : null
    const row = await findAdhocByCode(app.db, code)
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    if (claimToken && (row.claim_mode !== 'email_link' || row.claim_token_used_at || hashToken(claimToken) !== row.claim_token_hash)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    }
    if (!['open', 'claimed'].includes(row.state) || new Date(row.expires_at).getTime() <= Date.now()) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    }
    const helperAvailable = Boolean(app.config.helperBinaryPath && existsSync(app.config.helperBinaryPath))
    const macHelperAvailable = Boolean(
        app.config.macHelperBinaryPath &&
        existsSync(app.config.macHelperBinaryPath) &&
        app.config.env !== 'test' && process.env.REYDESK_MAC_HELPER_VERIFIED === 'true',
      )
    const androidHelperAvailable = Boolean(app.config.androidApkPath && existsSync(app.config.androidApkPath))
    const platform = clientPlatform(request)
    const sessionState = row.remote_session_id
      ? (await withTenant(app.db, row.tenant_id, (client) => client.query('SELECT state FROM remote_sessions WHERE id = $1', [row.remote_session_id]))).rows[0]?.state as string | undefined
      : undefined
    return reply.send(publicAdhoc(row, helperAvailable, macHelperAvailable, androidHelperAvailable, platform, sessionState))
  })

  app.get(
    '/connect/:code/download',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
      }
      const code = codeResult.data
      const row = await findAdhocByCode(app.db, code)
      if (!row || row.state !== 'open' || new Date(row.expires_at).getTime() <= Date.now()) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
      }
      const platform = clientPlatform(request)
      let binaryPath = ''
      let filename = ''
      let contentType = 'application/octet-stream'
      if (platform === 'android') {
        binaryPath = app.config.androidApkPath
        filename = 'reydesk-agent.apk'
        contentType = 'application/vnd.android.package-archive'
      } else if (platform === 'macos' && process.env.REYDESK_MAC_HELPER_VERIFIED === 'true') {
        binaryPath = app.config.macHelperBinaryPath
        filename = 'reydesk-helper.dmg'
      } else if (platform === 'windows') {
        binaryPath = app.config.helperBinaryPath
        filename = 'reydesk-helper.exe'
      } else if (app.config.env === 'test' && app.config.helperBinaryPath) {
        binaryPath = app.config.helperBinaryPath
        filename = 'reydesk-helper.exe'
      }
      if (!binaryPath || !existsSync(binaryPath)) {
        const message = platform === 'macos'
          ? 'The macOS helper is not available yet. Use the browser support experience or ask your technician for a signed notarized package.'
          : platform === 'windows'
            ? 'The Windows helper is not available yet.'
            : platform === 'android'
              ? 'The Android agent is not available yet. Keep this page open to approve access and chat with your technician.'
              : 'A native helper is not available for this device. Use the browser support experience.'
        return reply.code(404).send({ error: { code: 'helper_unavailable', message } })
      }
      reply.header('Content-Type', contentType)
      reply.header('Content-Disposition', `attachment; filename="${filename}"`)
      return reply.send(createReadStream(binaryPath))
    },
  )

  app.post(
    '/connect/:code/claim',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const code = codeResult.data
      const body = claimSchema.parse(request.body)
      const query = request.query as { claimToken?: string }
      const claimToken = typeof query.claimToken === 'string' ? query.claimToken : null
      const fingerprint = claimFingerprint(request)
      const row = await findAdhocByCode(app.db, code)
      if (!row) throw AppError.notFound('This support link is invalid or expired.')
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw AppError.notFound('This support link is invalid or expired.')
      }
      if (row.claim_mode === 'email_link') {
        if (!claimToken || row.claim_token_used_at || hashToken(claimToken) !== row.claim_token_hash || !fingerprint) {
          throw AppError.notFound('This secure support link is invalid or has expired.')
        }
        const fingerprintHash = hashToken(fingerprint)
        if (row.claim_fingerprint_hash && row.claim_fingerprint_hash !== fingerprintHash) {
          throw AppError.notFound('This secure support link is already bound to another device.')
        }
      }

      const effectiveClaimToken = row.claim_mode === 'email_link' ? claimToken : null
      const effectiveFingerprint = row.claim_mode === 'email_link' ? fingerprint : null
      const deviceToken = `reydesk_dev_${randomBytes(24).toString('base64url')}`
      const claimed = await withTenant(app.db, row.tenant_id, async (client) => {
        const consumed = await client.query(
          `UPDATE adhoc_sessions
              SET state = 'claimed',
                claimed_at = now(),
                claim_token_used_at = CASE WHEN $2::text IS NULL THEN claim_token_used_at ELSE now() END,
                claim_fingerprint_hash = CASE
                  WHEN $2::text IS NULL THEN claim_fingerprint_hash
                  ELSE COALESCE(claim_fingerprint_hash, $3::text)
                END,
                updated_at = now()
            WHERE id = $1
              AND state = 'open'
              AND expires_at > now()
              AND (
                claim_mode = 'code'
                OR (
                  claim_mode = 'email_link'
                  AND claim_token_hash = $2
                  AND claim_token_used_at IS NULL
                  AND ($3::text IS NOT NULL)
                  AND (claim_fingerprint_hash IS NULL OR claim_fingerprint_hash = $3)
                )
              )
           RETURNING id`,
          [row.id, effectiveClaimToken ? hashToken(effectiveClaimToken) : null, effectiveFingerprint ? hashToken(effectiveFingerprint) : null],
        )
        if (!consumed.rowCount) throw AppError.conflict('This support link is no longer available.', 'code_unavailable')

        const name = body.name ?? body.hostname ?? 'Ad-hoc support device'
        const device = (
          await client.query(
            `INSERT INTO devices
               (tenant_id, name, hostname, os, os_version, arch, ip_address, agent_version,
                agent_token_hash, agent_token_expires_at, adhoc, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, $8, true, now())
             RETURNING id, name`,
            [row.tenant_id, name, body.hostname ?? '', body.os ?? '', body.osVersion ?? '', body.arch ?? '', hashToken(deviceToken), row.expires_at],
          )
        ).rows[0]

        const session = (
          await client.query(
            `INSERT INTO remote_sessions
               (tenant_id, device_id, type, state, permissions, reason, requested_by, recording_mode, recording_retention_days)
             VALUES ($1, $2, 'attended', 'consent_pending', $3, $4, $5, 'metadata', 30)
             RETURNING id, state`,
            [row.tenant_id, device.id, row.permissions, row.reason, row.requested_by],
          )
        ).rows[0]

        await client.query('UPDATE adhoc_sessions SET device_id = $2, remote_session_id = $3, updated_at = now() WHERE id = $1', [
          row.id,
          device.id,
          session.id,
        ])

        // Parity with the managed session-create path: the technician who
        // issued the code owns the resulting session, so the console's
        // participant list, invite, and transfer features work unchanged.
        await client.query(
          `INSERT INTO session_participants (tenant_id, session_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT (session_id, user_id) DO UPDATE SET role = 'owner'`,
          [row.tenant_id, session.id, row.requested_by],
        )
        await client.query(
          `INSERT INTO session_events (tenant_id, session_id, actor_type, actor_id, event, payload)
           VALUES ($1, $2, 'agent', $3, 'session.created', $4)`,
          [row.tenant_id, session.id, device.id, JSON.stringify({ type: 'attended', adhoc: true, codeSessionId: row.id })],
        )

        await recordAudit(client, row.tenant_id, {
          actorType: 'agent',
          action: 'device.enrolled',
          objectType: 'device',
          objectId: device.id,
          ip: request.ip,
          payload: { name, adhoc: true, codeSessionId: row.id },
        })
        await notify(client, row.tenant_id, {
          userId: row.requested_by,
          kind: 'session.adhoc.claimed',
          subjectType: 'remote_session',
          subjectId: session.id,
          body: `Your support code was claimed by ${name}. Open the live session to connect.`,
        })
        return { device, session }
      })

      return reply.code(201).send({
        device: claimed.device,
        deviceToken,
        session: claimed.session,
        relayUrl: app.config.relayUrl,
      })
    },
  )

  /** Resolve the adhoc row + live session for a claimed code and device. */
  async function claimedSession(pool: DbPool, code: string, deviceId: string): Promise<{ row: AdhocRow; session: { id: string; state: string; permissions: string[]; requested_by: string | null } }> {
    const row = await findAdhocByCode(pool, code)
    if (!row || row.device_id !== deviceId) {
      throw AppError.notFound('This support link is invalid or expired.')
    }
    if (row.state !== 'claimed' || !row.remote_session_id) {
      throw AppError.conflict('This support session is not active yet.', 'session_not_claimed')
    }
    const session = (
      await withTenant(pool, row.tenant_id, (client) =>
        client.query('SELECT id, state, permissions, requested_by FROM remote_sessions WHERE id = $1', [row.remote_session_id]),
      )
    ).rows[0]
    if (!session) throw AppError.notFound('Session not found')
    return { row, session }
  }

  // Real-time relay join for the end-user browser companion (device-token auth).
  app.post(
    '/connect/:code/join',
    { preHandler: [authenticateAgent], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const ctx = request.deviceCtx!
      const { row, session } = await claimedSession(app.db, codeResult.data, ctx.deviceId)
      if (!LIVE_SESSION_STATES.has(session.state)) throw AppError.conflict('This support session is no longer live.', 'invalid_session_state')
      const joinToken = await withTenant(app.db, row.tenant_id, (client) => issueJoinToken(client, app, row.tenant_id, session.id, 'companion'))
      return reply.send({ relayUrl: app.config.relayUrl, joinToken, sessionId: session.id })
    },
  )

  // A browser companion can attach for chat when the native helper claimed the
  // code first. It receives no endpoint credentials and cannot publish media.
  app.post(
    '/connect/:code/companion-join',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const row = await findAdhocByCode(app.db, codeResult.data)
      if (!row || row.state !== 'claimed' || !row.remote_session_id || new Date(row.expires_at).getTime() <= Date.now()) {
        throw AppError.notFound('This support session is no longer available.')
      }
      const session = (
        await withTenant(app.db, row.tenant_id, (client) =>
          client.query('SELECT id, state FROM remote_sessions WHERE id = $1', [row.remote_session_id]),
        )
      ).rows[0]
      if (!session || !LIVE_SESSION_STATES.has(session.state)) {
        throw AppError.conflict('This support session is not in a joinable state.', 'invalid_session_state')
      }
      const joinToken = await withTenant(app.db, row.tenant_id, (client) => issueJoinToken(client, app, row.tenant_id, session.id, 'companion'))
      return reply.send({ sessionId: session.id, joinToken, relayUrl: app.config.relayUrl })
    },
  )

  // Chat history for the end-user browser companion (device-token auth).
  app.get(
    '/connect/:code/messages',
    { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const ctx = request.deviceCtx!
      const { row, session } = await claimedSession(app.db, codeResult.data, ctx.deviceId)
      const messages = await withTenant(app.db, row.tenant_id, (client) =>
        client.query(
          `SELECT m.id, m.sender_type, m.sender_id, m.body, m.created_at, u.name AS sender_name
             FROM session_messages m
             LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'technician'
            WHERE m.session_id = $1
            ORDER BY m.created_at ASC
            LIMIT 200`,
          [session.id],
        ),
      )
      return reply.send({ messages: messages.rows })
    },
  )

  // Persist a chat message from the end-user browser companion (device-token auth).
  app.post(
    '/connect/:code/messages',
    { preHandler: [authenticateAgent], config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const ctx = request.deviceCtx!
      const body = messageSchema.parse(request.body)
      const { row, session } = await claimedSession(app.db, codeResult.data, ctx.deviceId)
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('This support session is no longer accepting messages.', 'invalid_session_state')
      }
      const message = await withTenant(app.db, row.tenant_id, (client) =>
        client.query(
          `INSERT INTO session_messages (tenant_id, session_id, sender_type, sender_id, body)
           VALUES ($1, $2, 'agent', $3, $4) RETURNING id, sender_type, sender_id, body, created_at`,
          [row.tenant_id, session.id, ctx.deviceId, body.body],
        ),
      )
      return reply.code(201).send({ message: message.rows[0] })
    },
  )

  // Code-bearer chat routes are used when the native helper claimed the code
  // first. They intentionally expose only this session's chat and never issue
  // endpoint credentials.
  app.get(
    '/connect/:code/companion/messages',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const row = await findAdhocByCode(app.db, codeResult.data)
      if (!row?.remote_session_id || row.state !== 'claimed') throw AppError.notFound('This support session is no longer available.')
      const liveState = (await withTenant(app.db, row.tenant_id, (client) => client.query('SELECT state FROM remote_sessions WHERE id = $1', [row.remote_session_id]))).rows[0]?.state
      if (!liveState || !LIVE_SESSION_STATES.has(liveState)) throw AppError.conflict('This support session is not live.', 'invalid_session_state')
      const messages = await withTenant(app.db, row.tenant_id, (client) => client.query(
        `SELECT m.id, m.sender_type, m.sender_id, m.body, m.created_at, u.name AS sender_name
           FROM session_messages m
           LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'technician'
          WHERE m.session_id = $1 ORDER BY m.created_at ASC LIMIT 200`,
        [row.remote_session_id],
      ))
      return reply.send({ messages: messages.rows })
    },
  )

  app.post(
    '/connect/:code/companion/messages',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const body = messageSchema.parse(request.body)
      const row = await findAdhocByCode(app.db, codeResult.data)
      if (!row?.remote_session_id || row.state !== 'claimed') throw AppError.notFound('This support session is no longer available.')
      const liveState = (await withTenant(app.db, row.tenant_id, (client) => client.query('SELECT state FROM remote_sessions WHERE id = $1', [row.remote_session_id]))).rows[0]?.state
      if (!liveState || !LIVE_SESSION_STATES.has(liveState)) throw AppError.conflict('This support session is not live.', 'invalid_session_state')
      const message = await withTenant(app.db, row.tenant_id, (client) => client.query(
        `INSERT INTO session_messages (tenant_id, session_id, sender_type, sender_id, body)
         VALUES ($1, $2, 'agent', NULL, $3) RETURNING id, sender_type, sender_id, body, created_at`,
        [row.tenant_id, row.remote_session_id, body.body],
      ))
      return reply.code(201).send({ message: message.rows[0] })
    },
  )

  // Grant or decline the support session from the end-user browser companion.
  app.post(
    '/connect/:code/consent',
    { preHandler: [authenticateAgent], config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const ctx = request.deviceCtx!
      const body = consentSchema.parse(request.body)
      const { row, session } = await claimedSession(app.db, codeResult.data, ctx.deviceId)
      if (!['requested', 'consent_pending'].includes(session.state)) {
        throw AppError.conflict('This support session is no longer awaiting consent.', 'invalid_session_state')
      }
      const result = await withTenant(app.db, row.tenant_id, async (client) => {
        if (!body.granted) {
          const denied = (await client.query("UPDATE remote_sessions SET state = 'denied', updated_at = now() WHERE id = $1 RETURNING *", [session.id])).rows[0]
          await client.query(
            'UPDATE devices SET agent_token_hash = NULL, agent_token_expires_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2',
            [ctx.deviceId, row.tenant_id],
          )
          await client.query("UPDATE adhoc_sessions SET state = 'ended', updated_at = now() WHERE remote_session_id = $1 AND state = 'claimed'", [session.id])
          return { session: denied, joinToken: null }
        }
        const requested = session.permissions as string[]
        let effective = requested
        if (body.permissions) {
          effective = body.permissions.filter((permission) => requested.includes(permission))
          if (!effective.includes('view_screen')) effective = ['view_screen', ...effective]
        }
        const updated = (
          await client.query(
            `UPDATE remote_sessions SET state = 'connecting', permissions = $2, consented_at = now(), updated_at = now()
              WHERE id = $1 RETURNING *`,
            [session.id, effective],
          )
        ).rows[0]
        const joinToken = await issueJoinToken(client, app, row.tenant_id, session.id, 'agent')
        if (session.requested_by) {
          const deviceRow = (await client.query('SELECT name FROM devices WHERE id = $1 AND tenant_id = $2', [ctx.deviceId, row.tenant_id])).rows[0]
          await notify(client, row.tenant_id, {
            userId: session.requested_by,
            kind: 'session.adhoc.claimed',
            body: `${deviceRow?.name ?? 'Device'} accepted the remote support session. Click to open the session console.`,
            subjectType: 'session',
            subjectId: session.id,
          })
        }
        return { session: updated, joinToken }
      })
      return reply.send(result)
    },
  )

  // Lets the native helper attach to an already-claimed (browser-managed) session
  // purely as the streaming engine. The support code is the bearer credential.
  app.post(
    '/connect/:code/agent-join',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store')
      const { code: rawCode } = request.params as { code: string }
      const codeResult = publicCodeSchema.safeParse(rawCode)
      if (!codeResult.success) throw AppError.notFound('This support link is invalid or expired.')
      const row = await findAdhocByCode(app.db, codeResult.data)
      if (!row || row.state !== 'claimed' || !row.remote_session_id || new Date(row.expires_at).getTime() <= Date.now()) {
        throw AppError.notFound('This support session is no longer available.')
      }
      const session = (
        await withTenant(app.db, row.tenant_id, (client) =>
          client.query('SELECT id, state, permissions FROM remote_sessions WHERE id = $1', [row.remote_session_id]),
        )
      ).rows[0]
      if (!session || !LIVE_SESSION_STATES.has(session.state)) {
        throw AppError.conflict('This support session is not in a joinable state.', 'invalid_session_state')
      }
      const joinToken = await withTenant(app.db, row.tenant_id, (client) => issueJoinToken(client, app, row.tenant_id, session.id, 'agent'))
      return reply.send({ sessionId: session.id, joinToken, relayUrl: app.config.relayUrl, permissions: session.permissions, iceServers: buildIceServers(app.config.ice) })
    },
  )
}
