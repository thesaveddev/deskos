import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { hashPassword } from '../../core/auth/password.js'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
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

/**
 * Auth hardening routes — password reset, change password, email verification.
 * Mounted alongside the main auth routes.
 */
export async function authHardeningRoutes(app: FastifyInstance): Promise<void> {

  /** Request a password reset email. Always returns 200 to prevent enumeration. */
  app.post('/auth/forgot-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request) => {
    const body = forgotPasswordSchema.parse(request.body)

    // Always return 200 — don't reveal whether the email exists
    const { rows } = await app.db.query('SELECT id FROM users WHERE email = $1', [body.email])
    if (!rows[0]) return { ok: true }

    const { token } = await generatePasswordResetToken(app.db, rows[0].id)

    // In production, send email here. For now, log the token.
    const resetUrl = `${app.config.publicUrl}/reset-password?token=${token}`
    app.log.info({ email: body.email, resetUrl }, 'Password reset requested')

    // TODO: Send email via queue (see email queue implementation)
    // await emailQueue.add('password-reset', { to: body.email, resetUrl })

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

    app.log.info({ userId: request.user!.id, verifyUrl }, 'Email verification requested')
    // TODO: Send email via queue
    return { ok: true }
  })

  /** Verify email using a valid token (public — no auth required). */
  app.post('/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request) => {
    const body = verifyEmailSchema.parse(request.body)
    await verifyEmailVerificationToken(app.db, body.token)
    return { ok: true }
  })
}
