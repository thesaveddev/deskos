import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { signAccessToken, verifyAccessToken } from '../../core/auth/jwt.js'
import { hashPassword, verifyPassword } from '../../core/auth/password.js'
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../core/auth/totp.js'
import { isAccountLocked, recordFailedLogin, resetFailedLoginCount } from './auth.password-reset.js'
import { AppError } from '../../core/errors.js'
import { permissionsForRole, isOrgRole } from '../../core/permissions.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import '../../types.js'

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(256),
  name: z.string().min(1).max(200),
  tenantName: z.string().min(2).max(200),
})

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
  mfaCode: z.string().regex(/^\d{6,8}$/).optional(),
})

const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) })
const mfaCodeSchema = z.object({ code: z.string().regex(/^\d{6,8}$/) })

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'org'
}

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function issueTokens(app: FastifyInstance, userId: string, deviceFp?: string) {
  const jti = randomBytes(16).toString('hex')
  const accessToken = await signAccessToken(app.config, userId, jti)
  const refreshToken = randomBytes(48).toString('hex')
  const expiresAt = new Date(Date.now() + app.config.refreshTokenTtlDays * 86_400_000)
  await app.db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_fp, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, sha256hex(refreshToken), deviceFp ?? null, expiresAt],
  )
  return { accessToken, refreshToken, accessTokenTtlSec: app.config.accessTokenTtlSec }
}

export async function recordAuthAttempt(app: FastifyInstance, email: string, ip: string | undefined, success: boolean, reason?: string) {
  await app.db.query(
    'INSERT INTO auth_attempts (email, ip, success, reason) VALUES ($1, $2, $3, $4)',
    [email, ip ?? null, success, reason ?? null],
  )
}

export async function auditLoginAcrossTenants(app: FastifyInstance, userId: string, ip?: string, userAgent?: string) {
  const { rows } = await app.db.query('SELECT tenant_id FROM memberships WHERE user_id = $1 AND status = $2', [userId, 'active'])
  for (const { tenant_id: tenantId } of rows.slice(0, 25)) {
    await withTenant(app.db, tenantId, (client) =>
      recordAudit(client, tenantId, {
        actorId: userId,
        action: 'auth.login',
        objectType: 'user',
        objectId: userId,
        ip,
        userAgent,
      }),
    )
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = signupSchema.parse(request.body)

    const existing = await app.db.query('SELECT id FROM users WHERE email = $1', [body.email])
    if (existing.rowCount) throw AppError.conflict('An account with this email already exists', 'email_taken')

    const baseSlug = slugify(body.tenantName)
    let tenantId: string | undefined
    let slug = baseSlug
    for (let attempt = 0; attempt < 5 && !tenantId; attempt++) {
      try {
        const res = await app.db.query(
          'INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id',
          [body.tenantName, slug],
        )
        tenantId = res.rows[0].id
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          slug = `${baseSlug}-${randomBytes(3).toString('hex')}`
          continue
        }
        throw err
      }
    }
    if (!tenantId) throw AppError.conflict('Could not allocate a unique organisation slug', 'slug_taken')

    const passwordHash = await hashPassword(body.password, app.config.bcryptRounds)
    const userRes = await app.db.query(
      `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name`,
      [body.email, passwordHash, body.name],
    )
    const user = userRes.rows[0]
    await app.db.query(
      `INSERT INTO memberships (tenant_id, user_id, org_role, status) VALUES ($1, $2, 'owner', 'active')`,
      [tenantId, user.id],
    )

    await withTenant(app.db, tenantId, (client) =>
      recordAudit(client, tenantId, {
        actorId: user.id,
        action: 'tenant.created',
        objectType: 'tenant',
        objectId: tenantId,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        payload: { slug },
      }),
    )

    const tokens = await issueTokens(app, user.id)
    return reply
      .code(201)
      .send({ user: { id: user.id, email: user.email, name: user.name }, tenant: { id: tenantId, slug }, ...tokens })
  })

  app.post('/auth/login', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = loginSchema.parse(request.body)
    const { rows } = await app.db.query(
      'SELECT id, email, name, password_hash, status, mfa_enabled, mfa_secret FROM users WHERE email = $1',
      [body.email],
    )
    const user = rows[0]

    const passwordOk = user?.password_hash ? await verifyPassword(body.password, user.password_hash) : false
    if (!user || user.status !== 'active' || !passwordOk) {
      await recordAuthAttempt(app, body.email, request.ip, false, 'invalid_credentials')
      if (user) await recordFailedLogin(app.db, user.id)
      throw AppError.unauthorized('Invalid email or password', 'invalid_credentials')
    }

    // Check account lockout
    if (await isAccountLocked(app.db, user.id)) {
      await recordAuthAttempt(app, body.email, request.ip, false, 'account_locked')
      throw AppError.unauthorized('Account temporarily locked due to too many failed attempts. Try again in 15 minutes.', 'account_locked')
    }

    if (user.mfa_enabled) {
      if (!body.mfaCode) {
        await recordAuthAttempt(app, body.email, request.ip, false, 'mfa_required')
        throw new AppError(401, 'mfa_required', 'MFA code required')
      }
      if (!user.mfa_secret || !verifyTotp(body.mfaCode, user.mfa_secret)) {
        await recordAuthAttempt(app, body.email, request.ip, false, 'mfa_invalid')
        throw AppError.unauthorized('Invalid MFA code', 'mfa_invalid')
      }
    }

    await app.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id])
    await resetFailedLoginCount(app.db, user.id)
    await recordAuthAttempt(app, body.email, request.ip, true)
    await auditLoginAcrossTenants(app, user.id, request.ip, request.headers['user-agent'])

    const tokens = await issueTokens(app, user.id)
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens }
  })

  app.post('/auth/refresh', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const { refreshToken } = refreshSchema.parse(request.body)
    const tokenHash = sha256hex(refreshToken)
    const { rows } = await app.db.query(
      `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    )
    const row = rows[0]
    if (!row) throw AppError.unauthorized('Unknown refresh token', 'invalid_refresh')

    if (row.revoked_at) {
      await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [row.user_id])
      throw AppError.unauthorized('Refresh token reuse detected; all sessions revoked', 'refresh_reuse')
    }
    if (new Date(row.expires_at).getTime() < Date.now()) {
      throw AppError.unauthorized('Refresh token expired', 'refresh_expired')
    }

    await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id])
    const userRes = await app.db.query('SELECT id, email, name, status FROM users WHERE id = $1', [row.user_id])
    const user = userRes.rows[0]
    if (!user || user.status !== 'active') throw AppError.unauthorized('Account is not active')

    const tokens = await issueTokens(app, user.id)
    return { user: { id: user.id, email: user.email, name: user.name }, ...tokens }
  })

  app.post('/auth/logout', { preHandler: [authenticate] }, async (request) => {
    const { refreshToken } = refreshSchema.parse(request.body)
    await app.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [sha256hex(refreshToken), request.user!.id],
    )
    return { ok: true }
  })

  app.post('/auth/mfa/enable', { preHandler: [authenticate] }, async (request) => {
    const secret = generateTotpSecret()
    await app.db.query('UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2', [secret, request.user!.id])
    return {
      secret,
      otpauthUrl: otpauthUrl(secret, request.user!.email, 'DeskOS'),
      pending: true,
    }
  })

  app.post('/auth/mfa/verify', { preHandler: [authenticate] }, async (request) => {
    const { code } = mfaCodeSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1', [request.user!.id])
    const user = rows[0]
    if (!user?.mfa_secret) throw AppError.badRequest('MFA enrollment not started', 'mfa_not_started')
    if (!verifyTotp(code, user.mfa_secret)) throw AppError.badRequest('Invalid MFA code', 'mfa_invalid')
    await app.db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [request.user!.id])
    return { mfaEnabled: true }
  })

  app.post('/auth/mfa/disable', { preHandler: [authenticate] }, async (request) => {
    const { code } = mfaCodeSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT mfa_secret FROM users WHERE id = $1 AND mfa_enabled = true', [request.user!.id])
    const user = rows[0]
    if (!user?.mfa_secret) throw AppError.badRequest('MFA is not enabled', 'mfa_not_enabled')
    if (!verifyTotp(code, user.mfa_secret)) throw AppError.badRequest('Invalid MFA code', 'mfa_invalid')
    await app.db.query('UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1', [request.user!.id])
    return { mfaEnabled: false }
  })

  app.get('/me', { preHandler: [authenticate] }, async (request) => {
    const { rows } = await app.db.query(
      `SELECT m.org_role, m.status, t.id AS tenant_id, t.slug, t.name, t.settings
         FROM memberships m JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = $1
        ORDER BY t.name`,
      [request.user!.id],
    )
    const memberships = rows
      .filter((r) => r.status === 'active' && isOrgRole(r.org_role))
      .map((r) => ({
        tenant: {
          id: r.tenant_id,
          slug: r.slug,
          name: r.name,
          branding: (r.settings?.branding ?? {}) as Record<string, unknown>,
        },
        orgRole: r.org_role,
        permissions: permissionsForRole(r.org_role),
      }))
    return { user: request.user, memberships }
  })

  app.get('/auth/validate', async (request) => {
    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) throw AppError.unauthorized()
    try {
      const payload = await verifyAccessToken(app.config, header.slice(7))
      return { valid: true, sub: payload.sub }
    } catch {
      return { valid: false }
    }
  })
}
