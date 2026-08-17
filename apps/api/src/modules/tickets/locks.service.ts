import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

const LOCK_TTL_MINUTES = 30
const HEARTBEAT_INTERVAL_SECONDS = 30

export interface TicketLock {
  id: number
  ticket_id: string
  locked_by: string
  locked_by_name?: string
  locked_by_email?: string
  locked_at: string
  expires_at: string
  heartbeat_at: string
}

/**
 * Attempt to lock a ticket. Returns the lock if successful, or the existing lock info if already locked.
 */
export async function lockTicket(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<{ locked: boolean; lock?: TicketLock; held_by?: string }> {
  return withTenant(db, tenantId, async (client) => {
    // Expire stale locks first
    await client.query("DELETE FROM ticket_locks WHERE expires_at < now()")

    // Check if already locked by someone else
    const existing = await client.query(
      `SELECT l.*, u.name AS locked_by_name, u.email AS locked_by_email
       FROM ticket_locks l
       JOIN users u ON u.id = l.locked_by
       WHERE l.ticket_id = $1 AND l.expires_at > now() AND l.locked_by != $2`,
      [ticketId, userId],
    )

    if (existing.rows[0]) {
      return {
        locked: false,
        held_by: existing.rows[0].locked_by_name || existing.rows[0].locked_by_email,
      }
    }

    // Remove any existing lock by this user (re-lock)
    await client.query(
      'DELETE FROM ticket_locks WHERE ticket_id = $1 AND locked_by = $2',
      [ticketId, userId],
    )

    // Create new lock
    const { rows } = await client.query(
      `INSERT INTO ticket_locks (tenant_id, ticket_id, locked_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4))
       RETURNING *`,
      [tenantId, ticketId, userId, LOCK_TTL_MINUTES],
    )

    return { locked: true, lock: rows[0] }
  })
}

/**
 * Release a ticket lock.
 */
export async function unlockTicket(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (client) => {
    const result = await client.query(
      'DELETE FROM ticket_locks WHERE ticket_id = $1 AND locked_by = $2',
      [ticketId, userId],
    )
    return (result.rowCount ?? 0) > 0
  })
}

/**
 * Extend a lock's expiry (heartbeat).
 */
export async function heartbeatLock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (client) => {
    const result = await client.query(
      `UPDATE ticket_locks
       SET heartbeat_at = now(), expires_at = now() + make_interval(mins => $3)
       WHERE ticket_id = $1 AND locked_by = $2 AND expires_at > now()`,
      [ticketId, userId, LOCK_TTL_MINUTES],
    )
    return (result.rowCount ?? 0) > 0
  })
}

/**
 * Check who has a ticket locked.
 */
export async function getTicketLock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
): Promise<TicketLock | null> {
  return withTenant(db, tenantId, async (client) => {
    // Expire stale locks
    await client.query("DELETE FROM ticket_locks WHERE expires_at < now()")

    const { rows } = await client.query(
      `SELECT l.*, u.name AS locked_by_name, u.email AS locked_by_email
       FROM ticket_locks l
       JOIN users u ON u.id = l.locked_by
       WHERE l.ticket_id = $1 AND l.expires_at > now()`,
      [ticketId],
    )
    return rows[0] ?? null
  })
}
