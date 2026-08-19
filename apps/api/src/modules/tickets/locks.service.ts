import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

export const TICKET_LOCK_TTL_MINUTES = 5
export const TICKET_VIEWER_TTL_MINUTES = 2

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

export interface LockedTicketSummary extends TicketLock {
  ticket_number: number
  ticket_subject: string
  ticket_status: string
}

export interface LockReleaseRequest {
  id: string
  ticket_id: string
  requested_by: string
  requested_by_name?: string
  locked_by: string
  locked_by_name?: string
  message: string
  status: 'pending' | 'approved' | 'denied' | 'cancelled'
  created_at: string
  resolved_at: string | null
}

export interface TicketLockAcquireResult {
  lock: TicketLock | null
  acquired: boolean
  conflict: TicketLock | null
}

/** Raised when another active agent owns the ticket lock. */
export class TicketLockConflict extends Error {
  readonly lock: TicketLock

  constructor(lock: TicketLock) {
    super('Ticket is currently being worked on by another agent')
    this.name = 'TicketLockConflict'
    this.lock = lock
  }
}

async function readLock(client: DbClient, ticketId: string): Promise<TicketLock | null> {
  const { rows } = await client.query(
    `SELECT l.*, u.name AS locked_by_name, u.email AS locked_by_email
       FROM ticket_locks l
       JOIN users u ON u.id = l.locked_by
      WHERE l.ticket_id = $1 AND l.expires_at > now()`,
    [ticketId],
  )
  return rows[0] ?? null
}

/**
 * Atomically acquire or renew a lock. The unique ticket index is the final
 * concurrency guard; the upsert only updates a row already owned by userId.
 */
export async function acquireTicketLockOnClient(
  client: DbClient,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<TicketLockAcquireResult> {
  await client.query('DELETE FROM ticket_locks WHERE ticket_id = $1 AND expires_at <= now()', [ticketId])

  const result = await client.query(
    `INSERT INTO ticket_locks (tenant_id, ticket_id, locked_by, expires_at, heartbeat_at)
     VALUES ($1, $2, $3, now() + interval '5 minutes', now())
     ON CONFLICT (ticket_id) DO UPDATE
       SET expires_at = now() + interval '5 minutes', heartbeat_at = now()
       WHERE ticket_locks.tenant_id = EXCLUDED.tenant_id
         AND ticket_locks.locked_by = EXCLUDED.locked_by
         AND ticket_locks.expires_at > now()
     RETURNING *`,
    [tenantId, ticketId, userId],
  )

  if (result.rows[0]) {
    const lock = await readLock(client, ticketId)
    return { lock, acquired: true, conflict: null }
  }

  const conflict = await readLock(client, ticketId)
  return { lock: null, acquired: false, conflict }
}

/**
 * Auto-lock when an agent claims/assigns a ticket.
 */
export async function autoLockOnAssign(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<TicketLock> {
  return withTenant(db, tenantId, async (client) => {
    const result = await acquireTicketLockOnClient(client, tenantId, ticketId, userId)
    if (!result.lock) {
      if (result.conflict) throw new TicketLockConflict(result.conflict)
      throw new Error('Could not acquire ticket lock')
    }
    return result.lock
  })
}

/** Acquire a lock from an HTTP route and return a conflict without throwing. */
export async function acquireTicketLock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<TicketLockAcquireResult> {
  return withTenant(db, tenantId, (client) => acquireTicketLockOnClient(client, tenantId, ticketId, userId))
}

/** Release a lock owned by the current agent. */
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

/** Manager/admin force-unlock a ticket. */
export async function forceUnlock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
): Promise<boolean> {
  return withTenant(db, tenantId, async (client) => {
    const result = await client.query('DELETE FROM ticket_locks WHERE ticket_id = $1', [ticketId])
    return (result.rowCount ?? 0) > 0
  })
}

/**
 * Ensure a write is made by the lock owner, unless the caller is a manager.
 * Tickets without a lock remain editable for backwards compatibility.
 */
export async function assertTicketWriteAccess(
  client: DbClient,
  ticketId: string,
  userId: string,
  canOverride = false,
): Promise<void> {
  const lock = await readLock(client, ticketId)
  if (lock && lock.locked_by !== userId && !canOverride) throw new TicketLockConflict(lock)
}

/** Heartbeat — extend a lock while its owner is actively viewing. */
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

/** Check who has a ticket locked. */
export async function getTicketLock(
  db: DbPool,
  tenantId: string,
  ticketId: string,
): Promise<TicketLock | null> {
  return withTenant(db, tenantId, async (client) => {
    await client.query('DELETE FROM ticket_locks WHERE ticket_id = $1 AND expires_at <= now()', [ticketId])
    return readLock(client, ticketId)
  })
}

/** Start viewing a ticket (called when an agent opens the detail page). */
export async function startViewing(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    await client.query("DELETE FROM ticket_viewers WHERE viewing_at < now() - interval '2 minutes'")
    await client.query(
      `INSERT INTO ticket_viewers (tenant_id, ticket_id, user_id, viewing_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, ticket_id, user_id) DO UPDATE SET viewing_at = now()`,
      [tenantId, ticketId, userId],
    )
  })
}

/** Stop viewing a ticket (called on unmount / navigate away). */
export async function stopViewing(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  return withTenant(db, tenantId, async (client) => {
    await client.query('DELETE FROM ticket_viewers WHERE ticket_id = $1 AND user_id = $2', [ticketId, userId])
  })
}

/** Heartbeat viewing (called periodically while viewing). */
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

/** Get all current viewers of a ticket. */
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

export async function listActiveTicketLocks(db: DbPool, tenantId: string): Promise<LockedTicketSummary[]> {
  return withTenant(db, tenantId, async (client) => {
    await client.query("DELETE FROM ticket_locks WHERE expires_at <= now()")
    const { rows } = await client.query(
      `SELECT l.*, t.number AS ticket_number, t.subject AS ticket_subject, t.status AS ticket_status,
              u.name AS locked_by_name, u.email AS locked_by_email
         FROM ticket_locks l
         JOIN tickets t ON t.id = l.ticket_id
         JOIN users u ON u.id = l.locked_by
        WHERE l.tenant_id = $1 AND l.expires_at > now()
        ORDER BY l.locked_at ASC`,
      [tenantId],
    )
    return rows
  })
}

export async function listLockReleaseRequests(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
  canOverride = false,
): Promise<LockReleaseRequest[]> {
  return withTenant(db, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT r.*, requester.name AS requested_by_name, owner.name AS locked_by_name
         FROM ticket_lock_release_requests r
         JOIN users requester ON requester.id = r.requested_by
         JOIN users owner ON owner.id = r.locked_by
        WHERE r.tenant_id = $1 AND r.ticket_id = $2
          AND (r.requested_by = $3 OR r.locked_by = $3 OR $4 = true)
        ORDER BY r.created_at DESC`,
      [tenantId, ticketId, userId, canOverride],
    )
    return rows
  })
}

export async function requestTicketLockRelease(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  requestedBy: string,
  message: string,
): Promise<LockReleaseRequest> {
  return withTenant(db, tenantId, async (client) => {
    const lock = await readLock(client, ticketId)
    if (!lock) throw new Error('This ticket is no longer locked')
    if (lock.locked_by === requestedBy) throw new Error('You already own this ticket lock')

    const result = await client.query(
      `INSERT INTO ticket_lock_release_requests (tenant_id, ticket_id, requested_by, locked_by, message)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (ticket_id, requested_by) WHERE status = 'pending'
       DO UPDATE SET message = EXCLUDED.message
       RETURNING *`,
      [tenantId, ticketId, requestedBy, lock.locked_by, message],
    )
    const request = result.rows[0]
    const ticket = (await client.query('SELECT number, subject FROM tickets WHERE id = $1', [ticketId])).rows[0]
    await notify(client, tenantId, {
      userId: lock.locked_by,
      kind: 'ticket.lock_release_requested',
      subjectType: 'ticket',
      subjectId: ticketId,
      body: `${requesterName(await client, requestedBy)} requested release of the lock on #${ticket.number} — ${ticket.subject}`,
    })
    return request
  })
}

async function requesterName(client: DbClient, userId: string): Promise<string> {
  return (await client.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]?.name ?? 'An agent'
}

export async function resolveLockReleaseRequest(
  db: DbPool,
  tenantId: string,
  ticketId: string,
  requestId: string,
  userId: string,
  decision: 'approve' | 'deny',
  canOverride = false,
): Promise<LockReleaseRequest> {
  return withTenant(db, tenantId, async (client) => {
    const request = (await client.query(
      `SELECT * FROM ticket_lock_release_requests
        WHERE id = $1 AND tenant_id = $2 AND ticket_id = $3`,
      [requestId, tenantId, ticketId],
    )).rows[0]
    if (!request) throw new Error('Release request not found')
    if (request.locked_by !== userId && !canOverride) throw new Error('Only the lock owner or a manager can resolve this request')
    if (request.status !== 'pending') return request

    const status = decision === 'approve' ? 'approved' : 'denied'
    const updated = (await client.query(
      `UPDATE ticket_lock_release_requests
          SET status = $2, resolved_at = now(), resolved_by = $3
        WHERE id = $1
        RETURNING *`,
      [requestId, status, userId],
    )).rows[0]
    if (decision === 'approve') {
      await client.query('DELETE FROM ticket_locks WHERE ticket_id = $1 AND locked_by = $2', [ticketId, request.locked_by])
    }
    return updated
  })
}
