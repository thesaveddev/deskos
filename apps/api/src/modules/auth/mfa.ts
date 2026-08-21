import { createHash, randomBytes } from 'node:crypto'
import type { DbPool, DbClient } from '../../db/pool.js'
import { AppError } from '../../core/errors.js'

const SETUP_TTL_MS = 10 * 60_000
const RECOVERY_CODE_COUNT = 10

export function hashMfaValue(value: string): string {
  return createHash('sha256').update(value.trim().toUpperCase()).digest('hex')
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase()
    return `${raw.slice(0, 5)}-${raw.slice(5)}`
  })
}

export async function createMfaSetupToken(db: DbPool, userId: string): Promise<string> {
  const token = `mfa_setup_${randomBytes(32).toString('base64url')}`
  await db.query('UPDATE mfa_setup_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId])
  await db.query(
    'INSERT INTO mfa_setup_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hashMfaValue(token), new Date(Date.now() + SETUP_TTL_MS)],
  )
  return token
}

export async function getMfaSetupUser(db: DbPool, token: string): Promise<string> {
  const result = await db.query(
    `SELECT user_id FROM mfa_setup_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashMfaValue(token)],
  )
  if (!result.rows[0]) throw AppError.unauthorized('This MFA setup link has expired. Sign in again to receive a new one.', 'mfa_setup_expired')
  return result.rows[0].user_id as string
}

export async function consumeMfaSetupToken(db: DbPool, token: string): Promise<string> {
  const result = await db.query(
    `UPDATE mfa_setup_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id`,
    [hashMfaValue(token)],
  )
  if (!result.rows[0]) throw AppError.unauthorized('This MFA setup link has expired or was already used.', 'mfa_setup_expired')
  return result.rows[0].user_id as string
}

export async function replaceRecoveryCodes(client: DbClient | DbPool, userId: string): Promise<string[]> {
  const codes = generateRecoveryCodes()
  const pool = 'connect' in client ? client : null
  const tx = pool ? await pool.connect() : client
  try {
    if (pool) await tx.query('BEGIN')
    await tx.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId])
    for (const code of codes) {
      await tx.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashMfaValue(code)])
    }
    if (pool) await tx.query('COMMIT')
    return codes
  } catch (error) {
    if (pool) await tx.query('ROLLBACK')
    throw error
  } finally {
    if (pool) (tx as DbClient).release()
  }
}

export async function consumeRecoveryCode(db: DbPool, userId: string, code: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE mfa_recovery_codes SET used_at = now(), last_used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, hashMfaValue(code)],
  )
  return (result.rowCount ?? 0) > 0
}

export async function remainingRecoveryCodeCount(db: DbPool, userId: string): Promise<number> {
  const result = await db.query('SELECT count(*)::int AS count FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId])
  return Number(result.rows[0]?.count ?? 0)
}
