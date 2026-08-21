import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashPassword } from '../../core/auth/password.js'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { withTenant } from '../../db/pool.js'
import {
  generatePasswordResetToken,
  verifyPasswordResetToken,
  markPasswordResetTokenUsed,
  generateEmailVerificationToken,
  verifyEmailVerificationToken,
  isAccountLocked,
  recordFailedLogin,
  resetFailedLoginCount,
} from './auth.password-reset.js'
import '../../types.js'

const forgotPasswordSchema = z.object({ email: z.string().email() })
const resetPasswordSchema = z.object({ token: z.string().min(64).max(128), password: z.string().min(10).max(256) })
const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(10).max(256) })
const verifyEmailSchema = z.object({ token: z.string().min(64).max(128) })
const invitationAcceptSchema = z.object({
  token: z.string().min(64).max(128),
  password: z.string().min(10).max(256).optional(),
  name: z.string().min(1).max(200).optional(),
})

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Auth hardening routes — password reset, change password, email verification.
 * Mounted alongside the main auth routes.
 */
export async function authHardeningRoutes(app: FastifyInstance): Promise<void> {

  /** Accept a single-use organisation invitation and activate the membership. */
  app.post('/auth/invitations/accept', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request) => {
    const body = invitationAcceptSchema.parse(request.body)
    const tokenHash = hashInvitationToken(body.token)
    const invitation = (await app.db.query(
      `SELECT oi.id, oi.tenant_id, oi.membership_id, oi.user_id, oi.expires_at, oi.accepted_at,
              u.email, u.status AS user_status, u.password_hash
         FROM organisation_invitations oi
         JOIN users u ON u.id = oi.user_id
        WHERE oi.token_hash = $1`,
      [tokenHash],
    )).rows[0]
    if (!invitation || invitation.accepted_at || new Date(invitation.expires_at).getTime() <= Date.now()) {
      throw AppError.badRequest('This invitation link is invalid or has expired. Ask your administrator to send a new invitation.', 'invitation_invalid')
    }
    if (invitation.user_status === 'disabled') throw AppError.badRequest('This account has been disabled. Contact your administrator.', 'account_disabled')
    if (!invitation.password_hash && !body.password) {
      throw AppError.badRequest('Create a password to finish setting up your ReyDesk account.', 'invitation_password_required')
    }

    await withTenant(app.db, invitation.tenant_id, async (client) => {
      const locked = (await client.query(
        `SELECT oi.id, oi.user_id, oi.membership_id, oi.expires_at, oi.accepted_at, u.status AS user_status, u.password_hash
           FROM organisation_invitations oi
           JOIN users u ON u.id = oi.user_id
          WHERE oi.id = $1
          FOR UPDATE`,
        [invitation.id],
      )).rows[0]
      if (!locked || locked.accepted_at || new Date(locked.expires_at).getTime() <= Date.now()) {
        throw AppError.badRequest('This invitation link is invalid or has expired. Ask your administrator to send a new invitation.', 'invitation_invalid')
      }
      const updates: string[] = ['status = \'active\'']
      const values: unknown[] = []
      if (body.password) {
        values.push(await hashPassword(body.password, app.config.bcryptRounds))
        updates.push(`password_hash = $${values.length}`)
      }
      if (body.name) {
        values.push(body.name)
        updates.push(`name = $${values.length}`)
      }
      values.push(locked.user_id)
      await client.query(`UPDATE users SET ${updates.join(', ')}, email_verified = true WHERE id = $${values.length}`, values)
      await client.query(`UPDATE memberships SET status = 'active' WHERE id = $1 AND user_id = $2`, [locked.membership_id, locked.user_id])
      await client.query(`UPDATE organisation_invitations SET accepted_at = now() WHERE id = $1`, [locked.id])
    })

    return { ok: true, email: invitation.email }
  })

  /** Request a password reset email. Always returns 200 to prevent enumeration. */
  app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const body = forgotPasswordSchema.parse(request.body)

    // Always return 200 — don't reveal whether the email exists
    const email = body.email.trim().toLowerCase()
    const { rows } = await app.db.query('SELECT id FROM users WHERE lower(email) = $1 AND status = \'active\'', [email])
    if (!rows[0]) return { ok: true }

    const { token } = await generatePasswordResetToken(app.db, rows[0].id)
    const resetUrl = `${app.config.publicUrl}/reset-password?token=${token}`
    const message = app.mailer.buildPasswordResetMail(email, resetUrl)
    const jobId = await app.emailQueue.addAndSend(message)
    app.log.info({ email, jobId, mailConfigured: app.mailer.enabled }, 'Password reset email queued')

    // Always return the same response, including when SMTP is unavailable, so
    // this endpoint cannot be used to discover registered accounts.
    return { ok: true }
  })

  /** Reset password using a valid token. */
  app.post('/auth/reset-password', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = resetPasswordSchema.parse(request.body)

    const userId = await verifyPasswordResetToken(app.db, body.token)
    const passwordHash = await hashPassword(body.password, app.config.bcryptRounds)

    await app.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId])
    await markPasswordResetTokenUsed(app.db, body.token)

    // Revoke all existing sessions for this user (security best practice)
    await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])

    app.log.info({ userId }, 'Password reset completed')
    return { ok: true }
  })

  /** Change password while logged in. */
  app.post('/auth/change-password', { preHandler: [authenticate] }, async (request) => {
    const body = changePasswordSchema.parse(request.body)
    const { hashPassword: hash, verifyPassword } = await import('../../core/auth/password.js')

    const { rows } = await app.db.query('SELECT password_hash FROM users WHERE id = $1', [request.user!.id])
    const user = rows[0]
    if (!user) throw AppError.notFound('User not found')

    const valid = await verifyPassword(body.currentPassword, user.password_hash)
    if (!valid) throw AppError.unauthorized('Current password is incorrect', 'invalid_password')

    const newHash = await hash(body.newPassword, app.config.bcryptRounds)
    await app.db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, request.user!.id])

    // Revoke all other sessions (keep current one)
    // Note: we can't easily identify the current session's refresh token here,
    // so we revoke all and the current session continues via its access token
    await app.db.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [request.user!.id],
    )

    return { ok: true }
  })

  /** Request email verification. */
  app.post('/auth/verify-email/request', { preHandler: [authenticate] }, async (request) => {
    const { rows } = await app.db.query('SELECT email_verified FROM users WHERE id = $1', [request.user!.id])
    if (rows[0]?.email_verified) return { ok: true, message: 'Email already verified' }

    const { token } = await generateEmailVerificationToken(app.db, request.user!.id)
    const verifyUrl = `${app.config.publicUrl}/verify-email?token=${token}`
    const email = (await app.db.query('SELECT email FROM users WHERE id = $1', [request.user!.id])).rows[0]?.email as string | undefined
    if (email) {
      const message = app.mailer.buildVerificationMail(email, verifyUrl)
      const jobId = await app.emailQueue.addAndSend(message)
      app.log.info({ userId: request.user!.id, jobId, mailConfigured: app.mailer.enabled }, 'Verification email queued')
    }
    return { ok: true }
  })

  /** Verify email using a valid token (public — no auth required). */
  app.post('/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = verifyEmailSchema.parse(request.body)
    await verifyEmailVerificationToken(app.db, body.token)
    return { ok: true }
  })
}
