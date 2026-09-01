import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../core/errors.js'
import type { DbClient, DbPool } from '../../db/pool.js'
import '../../types.js'

/** Hash an opaque device/enrol token for storage. Tokens are never stored plaintext. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Generate an opaque fleet token (plaintext returned to the caller once). */
export function generateEnrolToken(): string {
  return `reydesk_${randomBytes(24).toString('base64url')}`
}

/** Generate a phone-friendly numeric code. New enrollment and support sessions use 12 digits; shorter values remain available for legacy links. */
export function generateEnrolCode(length = 12): string {
  if (!Number.isInteger(length) || length < 8 || length > 12) {
    throw new Error('Enrollment code length must be between 8 and 12 digits')
  }
  const upperBound = 10 ** length
  return randomInt(0, upperBound).toString().padStart(length, '0')
}

/**
 * Rotate the opaque fleet token and its companion human enrollment code.
 * The code is twelve digits, expires after fifteen minutes, and is consumed by
 * the first successful customer/technician enrollment. Plaintext values are
 * returned exactly once. Must run inside a tenant-scoped txn.
 */
export async function rotateEnrolToken(
  client: DbClient,
  tenantId: string,
  actorId: string | null,
  label = 'default',
): Promise<{ plaintext: string; hash: string; code: string; codeHash: string; codeExpiresAt: Date }> {
  const plaintext = generateEnrolToken()
  const hash = hashToken(plaintext)
  const code = generateEnrolCode()
  const codeHash = hashToken(code)
  const codeExpiresAt = new Date(Date.now() + 15 * 60_000)
  await client.query(
    `UPDATE tenants
        SET enrol_token_hash = $2,
            enrol_token_label = $3,
            enrol_token_created_by = $4,
            enrol_token_created_at = now(),
            enrol_token_revoked_at = NULL,
            enrol_code_hash = $5,
            enrol_code_created_at = now(),
            enrol_code_expires_at = $6,
            enrol_code_used_at = NULL
      WHERE id = $1`,
    [tenantId, hash, label, actorId, codeHash, codeExpiresAt],
  )
  return { plaintext, hash, code, codeHash, codeExpiresAt }
}

/**
 * Find a device by its bearer token before a tenant is known. The devices table
 * remains FORCE RLS protected; migration 0008 grants this transaction a
 * token-hash-only read path, while its write policy still requires a tenant
 * context. The hash is set as a LOCAL transaction setting and never persisted.
 */
async function findDeviceByToken(pool: DbPool, token: string): Promise<{ id: string; tenant_id: string } | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tokenHash = hashToken(token)
    await client.query("SELECT set_config('app.device_token_hash', $1, true)", [tokenHash])
    const { rows } = await client.query(
      `SELECT id, tenant_id
         FROM devices
        WHERE agent_token_hash = $1
          AND (agent_token_expires_at IS NULL OR agent_token_expires_at > now())`,
      [tokenHash],
    )
    await client.query('COMMIT')
    return rows[0]
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

/**
 * Device-token authentication for agent endpoints. The agent presents
 * `Authorization: Bearer <device-token>`; the sha256 hash is looked up on the
 * devices table so the token is bound to a specific device + tenant.
 */
export async function authenticateAgent(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing device token')
  }
  const token = header.slice('Bearer '.length).trim()
  if (token.length === 0) throw AppError.unauthorized('Missing device token')
  if (token.length > 300) throw AppError.unauthorized('Invalid device token')

  const device = await findDeviceByToken(request.server.db, token)
  if (!device) throw AppError.unauthorized('Unknown or revoked device token')
  request.deviceCtx = { deviceId: device.id, tenantId: device.tenant_id }
}
