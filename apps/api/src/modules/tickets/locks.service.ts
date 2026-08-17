import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

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

export interface TicketViewer {
  user_id: string
  name: string
  email: string
  viewing_at: string
}

/**
 * Auto-lock when an agent claims/assigns a ticket.
 */
export async function autoLockOnAssign(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    // Clean stale locks
    await client.query("DELETE FROM ticket_locks WHERE expires_at < now()")
    // Remove existing lock for this user on this ticket
    await client.query('DELETE FROM ticket_locks WHERE ticket_id = $1 AND locked_by = $2', [ticketId, userId])
    // Create new lock
    await client.query(
      `INSERT INTO ticket_locks (tenant_id, ticket_id, locked_by, expires_at)
       VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [tenantId, ticketId, userId],
    )
  })
}

/**
 * Release lock (agent navigated away or manually released).
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
 * Manager/admin force-unlock a ticket locked by someone else.
 */
export async function forceUnlock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (client) => {
    const result = await client.query(
      'DELETE FROM ticket_locks WHERE ticket_id = $1',
      [ticketId],
    )
    return (result.rowCount ?? 0) > 0
  })
}

/**
 * Heartbeat — extend lock while agent is actively viewing.
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
       SET heartbeat_at = now(), expires_at = now() + interval '5 minutes'
       WHERE ticket_id = $1 AND locked_by = $2 AND expires_at > now()`,
      [ticketId, userId],
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

/**
 * Start viewing a ticket (called when agent opens the detail page).
 */
export async function startViewing(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    await client.query("DELETE FROM ticket_viewers WHERE viewing_at < now() - interval '2 minutes'")
    // Upsert: update if exists, insert if not
    await client.query(
      `INSERT INTO ticket_viewers (tenant_id, ticket_id, user_id, viewing_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, ticket_id, user_id) DO UPDATE SET viewing_at = now()`,
      [tenantId, ticketId, userId],
    )
  })
}

/**
 * Stop viewing a ticket (called on unmount / navigate away).
 */
export async function stopViewing(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    await client.query(
      'DELETE FROM ticket_viewers WHERE ticket_id = $1 AND user_id = $2',
      [ticketId, userId],
    )
  })
}

/**
 * Heartbeat viewing (called periodically while viewing).
 */
export async function heartbeatViewing(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    await client.query(
      `UPDATE ticket_viewers SET viewing_at = now()
       WHERE ticket_id = $1 AND user_id = $2`,
      [ticketId, userId],
    )
  })
}

/**
 * Get all current viewers of a ticket.
 */
export async function getViewers(
  db: DbPool,
  tenantId: string,
  ticketId: string,
): Promise<TicketViewer[]> {
  return withTenant(db, tenantId, async (client) => {
    await client.query("DELETE FROM ticket_viewers WHERE viewing_at < now() - interval '2 minutes'")
    const { rows } = await client.query(
      `SELECT v.user_id, u.name, u.email, v.viewing_at
       FROM ticket_viewers v
       JOIN users u ON u.id = v.user_id
       WHERE v.ticket_id = $1
       ORDER BY v.viewing_at DESC`,
      [ticketId],
    )
    return rows
  })
}
