import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { ensureTenantDefaults, getDefaultSlaPolicy } from '../tenants/defaults.js'
import { computeDeadlines } from '../tickets/sla.js'
import { dispatchTicketTriage } from '../ai/triage.js'
import '../../types.js'

const createSchema = z.object({
  subject: z.string().min(3).max(300),
  description: z.string().max(20_000).optional(),
})

const replySchema = z.object({ body: z.string().min(1).max(20_000) })

/**
 * Customer portal endpoints. Any tenant member may use them, but data is
 * strictly limited to tickets they requested — the end-user role carries no
 * staff permissions, and staff ticket routes are separate.
 */
export async function portalRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.get('/portal/tickets', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const tickets = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT id, number, type, status, priority, subject, due_resolution_at,
                  resolved_at, created_at, updated_at
             FROM tickets
            WHERE requester_id = $1
            ORDER BY created_at DESC
            LIMIT 100`,
          [request.user!.id],
        )
        .then((r) => r.rows),
    )
    return { tickets }
  })

  app.post('/portal/tickets', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)

    const defaults = await ensureTenantDefaults(app.db, ctx.tenantId)
    const policy = await getDefaultSlaPolicy(app.db, ctx.tenantId)
    const { dueResponseAt, dueResolutionAt } = computeDeadlines({
      priority: 'p3',
      matrix: policy.matrix,
      schedule: policy.businessHoursSchedule,
    })

    const ticket = await withTenant(app.db, ctx.tenantId, async (client) => {
      const counter = await client.query(
        'UPDATE tenants SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter',
        [ctx.tenantId],
      )
      const number = counter.rows[0].ticket_counter as number

      const res = await client.query(
        `INSERT INTO tickets
           (tenant_id, number, type, status, priority, subject, requester_id,
            team_id, category_id, sla_policy_id, source, due_response_at, due_resolution_at)
         VALUES ($1, $2, 'incident', 'new', 'p3', $3, $4, $5, $6, $7, 'portal', $8, $9)
         RETURNING *`,
        [
          ctx.tenantId, number, body.subject, request.user!.id,
          defaults.teamId, defaults.categoryId, policy.id,
          dueResponseAt, dueResolutionAt,
        ],
      )
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
         VALUES ($1, $2, $3, 'message', 'public', $4)`,
        [ctx.tenantId, res.rows[0].id, request.user!.id, body.description ?? body.subject],
      )
      return res.rows[0]
    })

    void dispatchTicketTriage(ctx.tenantId, ticket.id as string, 'created').catch(() => undefined)
    return reply.code(201).send({ ticket })
  })

  app.get('/portal/tickets/:number', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const { number } = request.params as { number: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tickets WHERE number = $1 AND requester_id = $2`,
        [Number(number), request.user!.id],
      )
      const ticket = rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      const threads = await client.query(
        `SELECT th.id, th.kind, th.body, th.created_at, u.name AS author_name
           FROM ticket_threads th
           LEFT JOIN users u ON u.id = th.author_id
          WHERE th.ticket_id = $1 AND th.visibility = 'public'
          ORDER BY th.created_at ASC`,
        [ticket.id],
      )
      return { ticket, threads: threads.rows }
    })
  })

  app.post('/portal/tickets/:number/reply', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { number } = request.params as { number: string }
    const body = replySchema.parse(request.body)

    const thread = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tickets WHERE number = $1 AND requester_id = $2`,
        [Number(number), request.user!.id],
      )
      const ticket = rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')

      const res = await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
         VALUES ($1, $2, $3, 'message', 'public', $4) RETURNING *`,
        [ctx.tenantId, ticket.id, request.user!.id, body.body],
      )
      if (ticket.status === 'pending_user') {
        await client.query(`UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1`, [ticket.id])
        await client.query(
          `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
           VALUES ($1, $2, 'system_event', 'internal', 'Requester replied; status pending_user → open', $3::jsonb)`,
          [ctx.tenantId, ticket.id, JSON.stringify({ event: 'ticket.status', from: 'pending_user', to: 'open' })],
        )
      }
      if (ticket.assignee_id) {
        await notify(client, ctx.tenantId, {
          userId: ticket.assignee_id,
          kind: 'ticket.requester_replied',
          subjectType: 'ticket',
          subjectId: ticket.id,
          body: `${request.user!.name} replied on #${ticket.number} — ${ticket.subject}`,
        })
      }
      return res.rows[0]
    })
    void dispatchTicketTriage(ctx.tenantId, thread.ticket_id as string, 'requester_reply').catch(() => undefined)
    return reply.code(201).send({ thread })
  })

  /**
   * Requester resolves their own ticket — closes the request loop from the
   * portal side ("mark as solved"). Only the ticket's own requester may call
   * this; staff changes go through the regular status route.
   */
  app.post('/portal/tickets/:number/resolve', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { number } = request.params as { number: string }

    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM tickets WHERE number = $1 AND requester_id = $2`,
        [Number(number), request.user!.id],
      )
      const ticket = rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      if (ticket.status === 'resolved' || ticket.status === 'closed') {
        return { ticket, changed: false }
      }

      const res = await client.query(
        `UPDATE tickets
            SET status = 'resolved', resolved_at = COALESCE(resolved_at, now()), updated_at = now()
          WHERE id = $1 RETURNING *`,
        [ticket.id],
      )
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
         VALUES ($1, $2, 'system_event', 'internal', 'Requester marked the ticket as resolved', $3::jsonb)`,
        [ctx.tenantId, ticket.id, JSON.stringify({ event: 'ticket.status', from: ticket.status, to: 'resolved', source: 'portal' })],
      )
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'ticket.resolved',
        objectType: 'ticket',
        objectId: ticket.id,
        ip: request.ip,
        payload: { from: ticket.status, to: 'resolved', source: 'portal' },
      })
      if (ticket.assignee_id) {
        await notify(client, ctx.tenantId, {
          userId: ticket.assignee_id,
          kind: 'ticket.resolved',
          subjectType: 'ticket',
          subjectId: ticket.id,
          body: `${request.user!.name} resolved #${ticket.number} — ${ticket.subject} from the portal`,
        })
      }
      return { ticket: res.rows[0], changed: true }
    })

    return reply.code(result.changed ? 200 : 204).send(result.changed ? { ticket: result.ticket } : undefined)
  })
}
