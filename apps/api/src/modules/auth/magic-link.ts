import { createHash, randomBytes } from 'node:crypto'
import type { DbPool } from '../../db/pool.js'
import { AppError } from '../../core/errors.js'

export const MAGIC_LINK_TTL_MS = 15 * 60_000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createMagicLinkToken(
  db: DbPool,
  input: { userId: string; tenantId: string; ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = `reydesk_ml_${randomBytes(32).toString('base64url')}`
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS)

  // Only the most recent link for this user and tenant remains valid.
  await db.query(
    `UPDATE magic_link_tokens
        SET consumed_at = now()
      WHERE user_id = $1 AND tenant_id = $2 AND consumed_at IS NULL`,
    [input.userId, input.tenantId],
  )
  await db.query(
    `INSERT INTO magic_link_tokens
       (user_id, tenant_id, token_hash, expires_at, requested_ip, requested_user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [input.userId, input.tenantId, hashToken(token), expiresAt, input.ip ?? null, input.userAgent ?? null],
  )
  return { token, expiresAt }
}

export async function getMagicLinkToken(
  db: DbPool,
  token: string,
): Promise<{ id: string; userId: string; tenantId: string; expiresAt: Date }> {
  const result = await db.query(
    `SELECT id, user_id, tenant_id, expires_at
       FROM magic_link_tokens
      WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
    [hashToken(token)],
  )
  const row = result.rows[0]
  if (!row) throw AppError.unauthorized('This sign-in link is invalid, expired, or has already been used.', 'magic_link_expired')
  return {
    id: row.id as string,
    userId: row.user_id as string,
    tenantId: row.tenant_id as string,
    expiresAt: new Date(row.expires_at),
  }
}

export async function consumeMagicLinkToken(db: DbPool, id: string): Promise<void> {
  const result = await db.query(
    `UPDATE magic_link_tokens
        SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
    RETURNING id`,
    [id],
  )
  if (!result.rows[0]) {
    throw AppError.unauthorized('This sign-in link is invalid, expired, or has already been used.', 'magic_link_expired')
  }
}
