import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { notify } from '../../core/notify.js'
import { withTenant, type DbPool } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { assertTicketWriteAccess } from './locks.service.js'
import '../../types.js'

const createReminderSchema = z.object({
  dueAt: z.string().datetime(),
  note: z.string().trim().max(500).default(''),
})

const updateReminderSchema = z.object({
  dueAt: z.string().datetime().optional(),
  note: z.string().trim().max(500).optional(),
})

export interface TicketReminderRow {
  id: string
  ticket_id: string
  ticket_number: number
  ticket_subject: string
  user_id: string
  note: string
  due_at: string
  fired_at: string | null
  dismissed_at: string | null
  created_at: string
}

export async function registerReminderRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  /** List reminders for a ticket (visible to anyone who can read the ticket). */
  app.get('/tickets/:id/reminders', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id: ticketId } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const exists = await client.query('SELECT id FROM tickets WHERE id = $1', [ticketId])
      if (!exists.rows[0]) throw Object.assign(new Error('Ticket not found'), { statusCode: 404 })
      const rows = await client.query(
        `SELECT r.id, r.ticket_id, r.user_id, r.note, r.due_at, r.fired_at, r.dismissed_at, r.created_at,
                t.number AS ticket_number, t.subject AS ticket_subject
           FROM ticket_reminders r
           JOIN tickets t ON t.id = r.ticket_id
          WHERE r.ticket_id = $1
          ORDER BY r.due_at ASC`,
        [ticketId],
      )
      return { reminders: rows.rows }
    })
  })

  /** Create a reminder. The creator is the reminder owner. */
  app.post('/tickets/:id/reminders', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const { id: ticketId } = request.params as { id: string }
    const body = createReminderSchema.parse(request.body)
    const dueAt = new Date(body.dueAt)
    if (Number.isNaN(dueAt.getTime())) throw Object.assign(new Error('Invalid due date'), { statusCode: 400 })

    return withTenant(app.db, ctx.tenantId, async (client) => {
      await assertTicketWriteAccess(client, ticketId, userId)
      const inserted = await client.query(
        `INSERT INTO ticket_reminders (tenant_id, ticket_id, user_id, note, due_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, ticket_id, user_id, note, due_at, fired_at, dismissed_at, created_at`,
        [ctx.tenantId, ticketId, userId, body.note, dueAt.toISOString()],
      )
      const row = inserted.rows[0]
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: userId,
        action: 'ticket.reminder_created',
        objectType: 'ticket',
        objectId: ticketId,
        ip: request.ip,
        payload: { reminderId: row.id, dueAt: row.due_at },
      })
      return { reminder: row }
    })
  })

  /** Update a reminder's due time or note. Only the owner can edit. */
  app.patch('/reminders/:id', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const { id: reminderId } = request.params as { id: string }
    const body = updateReminderSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const sets: string[] = []
      const values: unknown[] = []
      if (body.dueAt !== undefined) {
        const dueAt = new Date(body.dueAt)
        if (Number.isNaN(dueAt.getTime())) throw Object.assign(new Error('Invalid due date'), { statusCode: 400 })
        values.push(dueAt.toISOString())
        sets.push(`due_at = $${values.length}`)
        // Re-arming a fired reminder is allowed (snooze); clear the fired flag.
        sets.push(`fired_at = NULL`)
      }
      if (body.note !== undefined) {
        values.push(body.note)
        sets.push(`note = $${values.length}`)
      }
      if (sets.length === 0) return { reminder: null }
      values.push(reminderId, ctx.tenantId, userId)
      const updated = await client.query(
        `UPDATE ticket_reminders SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${values.length - 2} AND tenant_id = $${values.length - 1} AND user_id = $${values.length}
         RETURNING id, ticket_id, user_id, note, due_at, fired_at, dismissed_at, created_at`,
        values,
      )
      if (!updated.rows[0]) throw Object.assign(new Error('Reminder not found'), { statusCode: 404 })
      return { reminder: updated.rows[0] }
    })
  })

  /** Dismiss (or delete) a reminder. Owner or anyone with ticket write can dismiss. */
  app.post('/reminders/:id/dismiss', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const { id: reminderId } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const updated = await client.query(
        `UPDATE ticket_reminders SET dismissed_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND (user_id = $3 OR dismissed_at IS NULL)
         RETURNING id, ticket_id, user_id, note, due_at, fired_at, dismissed_at, created_at`,
        [reminderId, ctx.tenantId, userId],
      )
      if (!updated.rows[0]) throw Object.assign(new Error('Reminder not found'), { statusCode: 404 })
      return { reminder: updated.rows[0] }
    })
  })

  /** Delete a reminder outright. Only the owner can delete. */
  app.delete('/reminders/:id', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const { id: reminderId } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const deleted = await client.query(
        'DELETE FROM ticket_reminders WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id',
        [reminderId, ctx.tenantId, userId],
      )
      if (!deleted.rows[0]) throw Object.assign(new Error('Reminder not found'), { statusCode: 404 })
      return { ok: true }
    })
  })
}

/** Fire all due reminders tenant-by-tenant. Runs on a 30s/60s scheduler. */
export async function fireDueRemindersForTenant(pool: DbPool, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const due = await client.query(
      `SELECT r.id, r.ticket_id, r.user_id, r.note, r.due_at,
              t.number, t.subject
         FROM ticket_reminders r
         JOIN tickets t ON t.id = r.ticket_id
        WHERE r.fired_at IS NULL AND r.dismissed_at IS NULL
          AND r.due_at <= now()
        ORDER BY r.due_at ASC
        LIMIT 100`,
    )
    let fired = 0
    for (const row of due.rows) {
      await client.query(
        'UPDATE ticket_reminders SET fired_at = now(), updated_at = now() WHERE id = $1 AND fired_at IS NULL',
        [row.id],
      )
      await notify(client, tenantId, {
        userId: row.user_id,
        kind: 'ticket.reminder',
        subjectType: 'ticket',
        subjectId: row.ticket_id,
        body: row.note
          ? `Reminder: #${row.number} — ${row.note}`
          : `Reminder: follow up on ticket #${row.number} (${row.subject})`,
      })
      fired++
    }
    return fired
  })
}

export async function fireAllDueReminders(pool: DbPool): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of rows) {
    try {
      total += await fireDueRemindersForTenant(pool, tenant.id)
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}

export function startReminderScheduler(pool: DbPool, intervalMs = 30_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void fireAllDueReminders(pool).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return timer
}