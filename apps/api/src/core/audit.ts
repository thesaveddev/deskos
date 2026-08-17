import { createHash } from 'node:crypto'
import type { DbClient } from '../db/pool.js'

export interface AuditEntry {
  actorType?: 'user' | 'system' | 'agent'
  actorId?: string | null
  action: string
  objectType?: string | null
  objectId?: string | null
  ip?: string | null
  userAgent?: string | null
  payload?: Record<string, unknown>
}

const ZERO_HASH = '0'.repeat(64)

function canonical(entry: {
  tenantId: string
  actorType: string
  actorId: string | null
  action: string
  objectType: string | null
  objectId: string | null
  payload: Record<string, unknown>
}): string {
  return JSON.stringify({
    t: entry.tenantId,
    at: entry.actorType,
    a: entry.actorId,
    act: entry.action,
    ot: entry.objectType,
    oi: entry.objectId,
    p: entry.payload,
  })
}

/**
 * Append a tamper-evident audit entry. Must be called within a tenant-scoped
 * transaction (withTenant) so row-level security applies. Entries form a hash
 * chain per tenant; each entry_hash commits to the previous entry.
 */
export async function recordAudit(
  client: DbClient,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [tenantId])

  const { rows } = await client.query(
    'SELECT entry_hash FROM audit_logs ORDER BY id DESC LIMIT 1',
  )
  const prevHash: string = rows[0]?.entry_hash ?? ZERO_HASH

  const actorType = entry.actorType ?? 'user'
  const actorId = entry.actorId ?? null
  const objectType = entry.objectType ?? null
  const objectId = entry.objectId ?? null
  const payload = entry.payload ?? {}

  const entryHash = createHash('sha256')
    .update(prevHash + '|' + canonical({ tenantId, actorType, actorId, action: entry.action, objectType, objectId, payload }))
    .digest('hex')

  await client.query(
    `INSERT INTO audit_logs
       (tenant_id, actor_type, actor_id, action, object_type, object_id, ip, user_agent, payload, prev_hash, entry_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
    [
      tenantId,
      actorType,
      actorId,
      entry.action,
      objectType,
      objectId,
      entry.ip ?? null,
      entry.userAgent ?? null,
      JSON.stringify(payload),
      prevHash,
      entryHash,
    ],
  )
}

/** Verify the integrity of a tenant's audit chain. Returns the first broken link, if any. */
export async function verifyAuditChain(
  client: DbClient,
  tenantId: string,
): Promise<{ ok: boolean; brokenAtId?: number }> {
  const { rows } = await client.query(
    `SELECT id, actor_type, actor_id, action, object_type, object_id, payload, prev_hash, entry_hash
       FROM audit_logs ORDER BY id ASC`,
  )
  let prev = ZERO_HASH
  for (const row of rows) {
    const expected = createHash('sha256')
      .update(
        prev +
          '|' +
          canonical({
            tenantId,
            actorType: row.actor_type,
            actorId: row.actor_id,
            action: row.action,
            objectType: row.object_type,
            objectId: row.object_id,
            payload: row.payload,
          }),
      )
      .digest('hex')
    if (expected !== row.entry_hash || row.prev_hash !== prev) {
      return { ok: false, brokenAtId: row.id }
    }
    prev = row.entry_hash
  }
  return { ok: true }
}
