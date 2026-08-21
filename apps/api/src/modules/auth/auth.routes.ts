import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { signAccessToken, verifyAccessToken } from '../../core/auth/jwt.js'
import { hashPassword, verifyPassword } from '../../core/auth/password.js'
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../core/auth/totp.js'
import { consumeMfaSetupToken, consumeRecoveryCode, createMfaSetupToken, getMfaSetupUser, remainingRecoveryCodeCount, replaceRecoveryCodes } from './mfa.js'
import { consumeMagicLinkToken, createMagicLinkToken, getMagicLinkToken } from './magic-link.js'
import { isAccountLocked, recordFailedLogin, resetFailedLoginCount } from './auth.password-reset.js'
import { AppError } from '../../core/errors.js'
import { ADMIN_OR_OWNER_ROLES, permissionsForRole, isOrgRole } from '../../core/permissions.js'
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
  // TOTP is 6 digits; recovery codes are formatted 5-5 hex characters.
  mfaCode: z.string().min(6).max(64).optional(),
})

const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256) })
const mfaCodeSchema = z.object({ code: z.string().min(6).max(64) })
const magicLinkRequestSchema = z.object({
  email: z.string().email().max(320),
  tenantSlug: z.string().trim().min(1).max(60).optional(),
})
const magicLinkVerifySchema = z.object({
  token: z.string().min(20).max(200),
  mfaCode: z.string().min(6).max(64).optional(),
})

function magicLinkSettings(settings: unknown): { portalEnabled: boolean; staffEnabled: boolean } {
  const raw = settings && typeof settings === 'object'
    ? (settings as Record<string, unknown>).magic_links as { portal_enabled?: boolean; staff_enabled?: boolean } | undefined
    : undefined
  return {
    // Customer portal magic links are the safe default for end users.
    portalEnabled: raw?.portal_enabled !== false,
    // Staff continue to use password sign-in unless an organization opts in.
    staffEnabled: raw?.staff_enabled === true,
  }
}

function magicLinkAllowed(role: string, settings: unknown): boolean {
  const policy = magicLinkSettings(settings)
  return role === 'end_user' ? policy.portalEnabled : policy.staffEnabled
}

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

async function verifyMfaFactor(app: FastifyInstance, userId: string, code: string, secret: string | null): Promise<boolean> {
  if (secret && verifyTotp(code, secret)) return true
  return consumeRecoveryCode(app.db, userId, code)
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
  try {
    await app.db.query(
      'INSERT INTO auth_attempts (email, ip, success, reason) VALUES ($1, $2, $3, $4)',
      [email, ip ?? null, success, reason ?? null],
    )
  } catch {
    // Best effort — don't let audit logging break login
  }
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

  app.post('/auth/magic-link/request', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request) => {
    const body = magicLinkRequestSchema.parse(request.body)
    const email = body.email.trim().toLowerCase()
    const params: unknown[] = [email]
    let tenantFilter = ''
    if (body.tenantSlug) {
      params.push(body.tenantSlug.toLowerCase())
      tenantFilter = ' AND lower(t.slug) = $2'
    }

    const { rows } = await app.db.query(
      `SELECT u.id, u.email, u.name, m.tenant_id, m.org_role, t.name AS tenant_name, t.slug, t.settings
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
         JOIN tenants t ON t.id = m.tenant_id
        WHERE lower(u.email) = $1 AND u.status = 'active'${tenantFilter}
        ORDER BY CASE WHEN m.org_role = 'end_user' THEN 0 ELSE 1 END, t.name
        LIMIT 20`,
      params,
    )
    const membership = rows.find((row) => magicLinkAllowed(row.org_role, row.settings))

    // Keep the response identical for unknown, disabled, and known accounts.
    // This prevents the endpoint from becoming an account or organization
    // enumeration oracle.
    if (!membership) return { ok: true }

    const { token } = await createMagicLinkToken(app.db, {
      userId: membership.id,
      tenantId: membership.tenant_id,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
    const baseUrl = app.config.publicUrl.replace(/\/$/, '')
    const signInUrl = `${baseUrl}/login?magic_token=${encodeURIComponent(token)}`
    const jobId = await app.emailQueue.addAndSend(app.mailer.buildMagicLinkMail(membership.email, signInUrl, membership.tenant_name))
    app.log.info({ userId: membership.id, tenantId: membership.tenant_id, jobId, mailConfigured: app.mailer.enabled }, 'Magic link queued')
    await recordAuthAttempt(app, email, request.ip, false, 'magic_link_requested')
    return { ok: true }
  })

  app.post('/auth/magic-link/verify', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (request) => {
    const body = magicLinkVerifySchema.parse(request.body)
    const token = await getMagicLinkToken(app.db, body.token)
    const { rows } = await app.db.query(
      `SELECT u.id, u.email, u.name, u.status, u.mfa_enabled, u.mfa_secret,
              m.org_role, t.name AS tenant_name, t.slug
         FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.status = 'active'
         JOIN tenants t ON t.id = m.tenant_id
        WHERE u.id = $1 AND u.status = 'active'`,
      [token.userId, token.tenantId],
    )
    const user = rows[0]
    if (!user || !magicLinkAllowed(user.org_role, (await app.db.query('SELECT settings FROM tenants WHERE id = $1', [token.tenantId])).rows[0]?.settings)) {
      throw AppError.unauthorized('This sign-in link is no longer available. Request a new link or use your password.', 'magic_link_disabled')
    }

    // A magic link is never an MFA bypass. If the account already has MFA,
    // keep the link pending until a valid TOTP or unused recovery code arrives.
    if (user.mfa_enabled) {
      if (!body.mfaCode) {
        throw new AppError(401, 'magic_mfa_required', 'Enter your authenticator or recovery code to finish signing in.', undefined, {
          challenge_token: body.token,
          email: user.email,
        })
      }
      if (!(await verifyMfaFactor(app, user.id, body.mfaCode, user.mfa_secret))) {
        await recordAuthAttempt(app, user.email, request.ip, false, 'magic_mfa_invalid')
        throw AppError.unauthorized('That authenticator or recovery code is not valid.', 'mfa_invalid')
      }
    }

    await consumeMagicLinkToken(app.db, token.id)
    await app.db.query('UPDATE users SET last_login_at = now(), failed_login_count = 0 WHERE id = $1', [user.id])
    await resetFailedLoginCount(app.db, user.id)
    await recordAuthAttempt(app, user.email, request.ip, true, 'magic_link')
    await auditLoginAcrossTenants(app, user.id, request.ip, request.headers['user-agent'])
    const tokens = await issueTokens(app, user.id)
    return { user: { id: user.id, email: user.email, name: user.name }, tenant: { id: token.tenantId, slug: user.slug }, ...tokens }
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

    // Check org-level MFA policy
    const { rows: memberships } = await app.db.query(
      `SELECT m.org_role, t.settings FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND m.status = 'active'`,
      [user.id],
    )
    const orgMfaPolicy = memberships.find((m) => m.settings?.mfa_policy)?.settings?.mfa_policy ?? 'optional'
    const isAdminOrOwner = memberships.some((m) => ADMIN_OR_OWNER_ROLES.includes(m.org_role))

    const mfaEnforced = orgMfaPolicy === 'required' || (orgMfaPolicy === 'admin_only' && isAdminOrOwner)

    if (mfaEnforced && !user.mfa_enabled) {
      // The password is already verified. Issue a short-lived, single-use
      // setup capability so a required-MFA user can enroll before receiving
      // normal application tokens.
      const setupToken = await createMfaSetupToken(app.db, user.id)
      await recordAuthAttempt(app, body.email, request.ip, false, 'mfa_setup_required')
      throw new AppError(403, 'mfa_setup_required', 'MFA setup is required before you can access this organization.', undefined, {
        setup_token: setupToken,
        expires_in_seconds: 600,
        email: user.email,
      })
    }

    if (user.mfa_enabled) {
      if (!body.mfaCode) {
        await recordAuthAttempt(app, body.email, request.ip, false, 'mfa_required')
        throw new AppError(401, 'mfa_required', 'MFA code required')
      }
      const totpValid = user.mfa_secret ? verifyTotp(body.mfaCode, user.mfa_secret) : false
      const recoveryValid = !totpValid ? await consumeRecoveryCode(app.db, user.id, body.mfaCode) : false
      if (!totpValid && !recoveryValid) {
        await recordAuthAttempt(app, body.email, request.ip, false, 'mfa_invalid')
        throw AppError.unauthorized('Invalid authentication or recovery code', 'mfa_invalid')
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

  // First-login setup is deliberately unauthenticated but requires the
  // password-verified, single-use setup token returned by /auth/login.
  app.post('/auth/mfa/setup/begin', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const body = z.object({ setupToken: z.string().min(20).max(200) }).parse(request.body)
    const userId = await getMfaSetupUser(app.db, body.setupToken)
    const user = (await app.db.query('SELECT email FROM users WHERE id = $1 AND status = \'active\'', [userId])).rows[0]
    if (!user) throw AppError.unauthorized('Account is not active', 'account_inactive')
    const secret = generateTotpSecret()
    await app.db.query('UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2', [secret, userId])
    return { email: user.email, secret, otpauthUrl: otpauthUrl(secret, user.email, 'ReyDesk'), expiresInSeconds: 600 }
  })

  app.post('/auth/mfa/setup/complete', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const body = z.object({ setupToken: z.string().min(20).max(200), code: z.string().regex(/^\d{6}$/) }).parse(request.body)
    const userId = await getMfaSetupUser(app.db, body.setupToken)
    const user = (await app.db.query('SELECT id, email, name, mfa_secret, status FROM users WHERE id = $1', [userId])).rows[0]
    if (!user || user.status !== 'active' || !user.mfa_secret || !verifyTotp(body.code, user.mfa_secret)) {
      throw AppError.badRequest('That authenticator code is not valid. Check the time on your device and try again.', 'mfa_invalid')
    }
    await consumeMfaSetupToken(app.db, body.setupToken)
    const recoveryCodes = await replaceRecoveryCodes(app.db, userId)
    await app.db.query('UPDATE users SET mfa_enabled = true, last_login_at = now(), failed_login_count = 0 WHERE id = $1', [userId])
    await recordAuthAttempt(app, user.email, request.ip, true, 'mfa_setup_completed')
    await auditLoginAcrossTenants(app, userId, request.ip, request.headers['user-agent'])
    const tokens = await issueTokens(app, userId)
    return { user: { id: user.id, email: user.email, name: user.name }, recoveryCodes, ...tokens }
  })

  app.get('/auth/mfa/recovery/status', { preHandler: [authenticate] }, async (request) => {
    return { remaining: await remainingRecoveryCodeCount(app.db, request.user!.id) }
  })

  app.post('/auth/mfa/recovery/regenerate', { preHandler: [authenticate] }, async (request) => {
    const { code } = mfaCodeSchema.parse(request.body)
    const user = (await app.db.query('SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1', [request.user!.id])).rows[0]
    if (!user?.mfa_enabled || !(await verifyMfaFactor(app, request.user!.id, code, user.mfa_secret))) {
      throw AppError.badRequest('Enter a current authenticator or unused recovery code to regenerate recovery codes.', 'mfa_invalid')
    }
    const recoveryCodes = await replaceRecoveryCodes(app.db, request.user!.id)
    return { recoveryCodes }
  })

  app.get('/auth/mfa/status', { preHandler: [authenticate] }, async (request) => {
    const user = (await app.db.query('SELECT mfa_enabled, mfa_secret FROM users WHERE id = $1', [request.user!.id])).rows[0]
    return { enabled: Boolean(user?.mfa_enabled), enrollmentStarted: Boolean(user?.mfa_secret), recoveryCodesRemaining: await remainingRecoveryCodeCount(app.db, request.user!.id) }
  })

  app.post('/auth/mfa/enable', { preHandler: [authenticate] }, async (request) => {
    const secret = generateTotpSecret()
    await app.db.query('UPDATE users SET mfa_secret = $1, mfa_enabled = false WHERE id = $2', [secret, request.user!.id])
    return {
      secret,
      otpauthUrl: otpauthUrl(secret, request.user!.email, 'ReyDesk'),
      pending: true,
    }
  })

  app.post('/auth/mfa/verify', { preHandler: [authenticate] }, async (request) => {
    const { code } = mfaCodeSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1', [request.user!.id])
    const user = rows[0]
    if (!user?.mfa_secret) throw AppError.badRequest('MFA enrollment not started', 'mfa_not_started')
    if (!verifyTotp(code, user.mfa_secret)) throw AppError.badRequest('Invalid MFA code', 'mfa_invalid')
    const recoveryCodes = await replaceRecoveryCodes(app.db, request.user!.id)
    await app.db.query('UPDATE users SET mfa_enabled = true WHERE id = $1', [request.user!.id])
    return { mfaEnabled: true, recoveryCodes }
  })

  app.post('/auth/mfa/disable', { preHandler: [authenticate] }, async (request) => {
    const { rows: policies } = await app.db.query(
      `SELECT m.org_role, t.settings FROM memberships m JOIN tenants t ON t.id = m.tenant_id WHERE m.user_id = $1 AND m.status = 'active'`,
      [request.user!.id],
    )
    const cannotDisable = policies.some((item) => item.settings?.mfa_policy === 'required' || (item.settings?.mfa_policy === 'admin_only' && ADMIN_OR_OWNER_ROLES.includes(item.org_role)))
    if (cannotDisable) throw new AppError(403, 'mfa_policy_required', 'Your organization requires MFA for this account. Ask an administrator to change the policy first.')
    const { code } = mfaCodeSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT mfa_secret FROM users WHERE id = $1 AND mfa_enabled = true', [request.user!.id])
    const user = rows[0]
    if (!user?.mfa_secret) throw AppError.badRequest('MFA is not enabled', 'mfa_not_enabled')
    if (!(await verifyMfaFactor(app, request.user!.id, code, user.mfa_secret))) throw AppError.badRequest('Invalid MFA or recovery code', 'mfa_invalid')
    await app.db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [request.user!.id])
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
          mfaPolicy: r.settings?.mfa_policy ?? 'optional',
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
