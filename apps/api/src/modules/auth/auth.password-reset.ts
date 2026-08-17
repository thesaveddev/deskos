import { randomBytes, createHash } from 'node:crypto'
import type { DbPool } from '../../db/pool.js'
import { AppError } from '../../core/errors.js'

function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Generate a password reset token for a user. Returns the raw token (to email). */
export async function generatePasswordResetToken(
  pool: DbPool,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  // Invalidate any existing unused tokens for this user
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  )

  const token = randomBytes(32).toString('hex')
  const tokenHash = sha256hex(token)
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour

  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  )

  return { token, expiresAt }
}

/** Verify a password reset token and return the user ID. */
export async function verifyPasswordResetToken(
  pool: DbPool,
  token: string,
): Promise<string> {
  const tokenHash = sha256hex(token)
  const { rows } = await pool.query(
    `SELECT id, user_id, expires_at, used_at
     FROM password_reset_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  )

  const row = rows[0]
  if (!row) throw AppError.badRequest('Invalid or expired reset token', 'invalid_token')
  if (row.used_at) throw AppError.badRequest('This reset token has already been used', 'token_used')
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw AppError.badRequest('This reset token has expired', 'token_expired')
  }

  return row.user_id
}

/** Mark a password reset token as used. */
export async function markPasswordResetTokenUsed(pool: DbPool, token: string): Promise<void> {
  const tokenHash = sha256hex(token)
  await pool.query(
    `UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1`,
    [tokenHash],
  )
}

/** Generate an email verification token. Returns the raw token. */
export async function generateEmailVerificationToken(
  pool: DbPool,
  userId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('hex')
  const tokenHash = sha256hex(token)
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours

  await pool.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  )

  return { token, expiresAt }
}

/** Verify an email verification token and mark the user as verified. */
export async function verifyEmailVerificationToken(
  pool: DbPool,
  token: string,
): Promise<void> {
  const tokenHash = sha256hex(token)
  const { rows } = await pool.query(
    `SELECT id, user_id, expires_at, verified_at
     FROM email_verification_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  )

  const row = rows[0]
  if (!row) throw AppError.badRequest('Invalid or expired verification token', 'invalid_token')
  if (row.verified_at) throw AppError.badRequest('Email already verified', 'already_verified')
  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw AppError.badRequest('Verification token has expired', 'token_expired')
  }

  await pool.query(
    `UPDATE email_verification_tokens SET verified_at = now() WHERE id = $1`,
    [row.id],
  )
  await pool.query(
    `UPDATE users SET email_verified = true WHERE id = $1`,
    [row.user_id],
  )
}

/** Check if an account is locked. */
export async function isAccountLocked(pool: DbPool, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT locked_until FROM users WHERE id = $1`,
    [userId],
  )
  const lockedUntil = rows[0]?.locked_until
  if (!lockedUntil) return false
  if (new Date(lockedUntil).getTime() > Date.now()) return true
  // Lockout expired, unlock
  await pool.query(
    `UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1`,
    [userId],
  )
  return false
}

/** Record a failed login attempt. Lock account after 5 failures. */
export async function recordFailedLogin(pool: DbPool, userId: string): Promise<void> {
  const { rows } = await pool.query(
    `UPDATE users SET failed_login_count = failed_login_count + 1
     WHERE id = $1 RETURNING failed_login_count`,
    [userId],
  )
  const count = rows[0]?.failed_login_count ?? 0
  if (count >= 5) {
    await pool.query(
      `UPDATE users SET locked_until = now() + interval '15 minutes'
       WHERE id = $1`,
      [userId],
    )
  }
}

/** Reset failed login count on successful login. */
export async function resetFailedLoginCount(pool: DbPool, userId: string): Promise<void> {
  await pool.query(
    `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`,
    [userId],
  )
}
