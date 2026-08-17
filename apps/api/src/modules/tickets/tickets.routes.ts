import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { emitWebhookEvent } from '../webhooks/webhooks.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { runAutomationsForTrigger } from '../automation/engine.js'
import { requestChangeApproval, requestServiceApproval } from '../catalogue/approvals.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { ensureTenantDefaults, getDefaultSlaPolicy } from '../tenants/defaults.js'
import { computeDeadlines } from './sla.js'
import '../../types.js'

const TICKET_STATUSES = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated', 'resolved', 'closed'] as const
const TICKET_TYPES = ['incident', 'service_request', 'question', 'problem', 'change', 'major_incident'] as const
const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const

const createSchema = z.object({
  subject: z.string().min(3).max(300),
  description: z.string().max(20_000).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  categoryId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  assigneeId: z.string().uuid().optional(),
  affectedUserId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  serviceId: z.string().uuid().optional(),
  rootCause: z.string().max(20_000).optional(),
  workaround: z.string().max(20_000).optional(),
  risk: z.enum(['low', 'medium', 'high']).optional(),
  implementationPlan: z.string().max(20_000).optional(),
  backoutPlan: z.string().max(20_000).optional(),
  scheduledAt: z.string().datetime().optional(),
  // Requester details (for when ticket is raised on behalf of someone else)
  requesterName: z.string().max(200).optional(),
  requesterEmail: z.string().email().optional(),
  requesterPhone: z.string().max(50).optional(),
  requesterDepartment: z.string().max(100).optional(),
  requesterCompany: z.string().max(200).optional(),
  requesterLocation: z.string().max(200).optional(),
})

const updateSchema = z.object({
  subject: z.string().min(3).max(300).optional(),
  priority: z.enum(PRIORITIES).optional(),
  impact: z.enum(['low', 'medium', 'high']).optional(),
  urgency: z.enum(['low', 'medium', 'high']).optional(),
  type: z.enum(TICKET_TYPES).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
  deviceId: z.string().uuid().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  rootCause: z.string().max(20_000).nullable().optional(),
  workaround: z.string().max(20_000).nullable().optional(),
  risk: z.enum(['low', 'medium', 'high']).nullable().optional(),
  implementationPlan: z.string().max(20_000).nullable().optional(),
  backoutPlan: z.string().max(20_000).nullable().optional(),
  scheduledAt: z.string().datetime().nullable().optional(),
})

const replySchema = z.object({
  body: z.string().min(1).max(20_000),
  visibility: z.enum(['public', 'internal']).optional(),
})

const statusSchema = z.object({ status: z.enum(TICKET_STATUSES) })
const assignSchema = z.object({
  assigneeId: z.string().uuid().nullable().optional(),
  teamId: z.string().uuid().nullable().optional(),
})

async function logSystemEvent(client: DbClient, tenantId: string, ticketId: string, body: string, meta: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
     VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
    [tenantId, ticketId, body, JSON.stringify(meta)],
  )
}

async function findTicket(client: DbClient, ticketId: string) {
  const { rows } = await client.query('SELECT * FROM tickets WHERE id = $1', [ticketId])
  return rows[0]
}

async function ensureDeviceBelongsToTenant(client: DbClient, deviceId: string | null | undefined): Promise<void> {
  if (!deviceId) return
  const { rows } = await client.query('SELECT id FROM devices WHERE id = $1', [deviceId])
  if (!rows[0]) throw AppError.notFound('Device not found')
}

export async function ticketRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.get('/tickets/counts', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const counts = await withTenant(app.db, ctx.tenantId, async (client) => {
      const byStatus = await client.query(
        `SELECT status, count(*)::int AS n FROM tickets GROUP BY status`,
      )
      const mine = await client.query(
        `SELECT count(*)::int AS n FROM tickets
          WHERE assignee_id = $1 AND status NOT IN ('resolved', 'closed')`,
        [request.user!.id],
      )
      const unassigned = await client.query(
        `SELECT count(*)::int AS n FROM tickets
          WHERE assignee_id IS NULL AND status NOT IN ('resolved', 'closed')`,
      )
      const slaRisk = await client.query(
        `SELECT count(*)::int AS n FROM tickets
          WHERE status NOT IN ('resolved', 'closed')
            AND (sla_response_breached OR sla_resolution_breached
                 OR (due_response_at IS NOT NULL AND first_response_at IS NULL AND due_response_at < now() + interval '60 minutes')
                 OR (due_resolution_at IS NOT NULL AND resolved_at IS NULL AND due_resolution_at < now() + interval '60 minutes'))`,
      )
      return { byStatus: byStatus.rows, mine: mine.rows[0].n, unassigned: unassigned.rows[0].n, slaRisk: slaRisk.rows[0].n }
    })
    return counts
  })

  app.get('/tickets/export.csv', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const rows = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT t.number, t.type, t.status, t.priority, t.subject,
                  ru.name AS requester, au.name AS assignee,
                  t.created_at, t.resolved_at
             FROM tickets t
             JOIN users ru ON ru.id = t.requester_id
             LEFT JOIN users au ON au.id = t.assignee_id
            ORDER BY t.number`,
        )
        .then((r) => r.rows),
    )
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = 'number,type,status,priority,subject,requester,assignee,created_at,resolved_at'
    const csv = [header, ...rows.map((r) => [r.number, r.type, r.status, r.priority, r.subject, r.requester, r.assignee, r.created_at?.toISOString() ?? '', r.resolved_at?.toISOString() ?? ''].map(esc).join(','))].join('\n')
    return reply.header('content-type', 'text/csv; charset=utf-8').send(csv)
  })

  app.get('/tickets', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as Record<string, string | undefined>
    const limit = Math.min(Number(q.limit ?? 50), 200)
    const offset = Math.max(0, Number(q.offset ?? 0))

    const tickets = await withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      if (q.status) {
        values.push(q.status)
        clauses.push(`t.status = $${values.length}`)
      }
      if (q.priority) {
        values.push(q.priority)
        clauses.push(`t.priority = $${values.length}`)
      }
      if (q.type) {
        values.push(q.type)
        clauses.push(`t.type = $${values.length}`)
      }
      if (q.team) {
        values.push(q.team)
        clauses.push(`t.team_id = $${values.length}`)
      }
      if (q.requester) {
        values.push(q.requester)
        clauses.push(`t.requester_id = $${values.length}`)
      }
      if (q.assignee === 'me') {
        values.push(request.user!.id)
        clauses.push(`t.assignee_id = $${values.length}`)
      } else if (q.assignee === 'none') {
        clauses.push('t.assignee_id IS NULL')
      } else if (q.assignee) {
        values.push(q.assignee)
        clauses.push(`t.assignee_id = $${values.length}`)
      }
      if (q.q) {
        values.push(`%${q.q}%`)
        clauses.push(`(t.subject ILIKE $${values.length} OR t.number::text = $${values.length + 1})`)
        values.push(q.q.replace(/^#/, ''))
      }
      if (q.date_from) {
        values.push(q.date_from)
        clauses.push(`t.created_at >= $${values.length}`)
      }
      if (q.date_to) {
        values.push(q.date_to)
        clauses.push(`t.created_at <= $${values.length}`)
      }
      // cursor-based pagination removed in favor of offset
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''

      // Sort
      const sortField = q.sort === 'priority' ? 't.priority' : q.sort === 'updated' ? 't.updated_at' : q.sort === 'number' ? 't.number' : 't.created_at'
      const sortDir = q.dir === 'asc' ? 'ASC' : 'DESC'

      // Count total matching rows
      const countValues = [...values]
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM tickets t
           JOIN users ru ON ru.id = t.requester_id
           ${where}`,
        countValues,
      )
      const total = countResult.rows[0]?.total ?? 0

      // Fetch page
      values.push(limit)
      const limitIdx = values.length
      values.push(offset)
      const offsetIdx = values.length
      const { rows } = await client.query(
        `SELECT t.*, ru.name AS requester_name, au.name AS assignee_name, tm.name AS team_name
           FROM tickets t
           JOIN users ru ON ru.id = t.requester_id
           LEFT JOIN users au ON au.id = t.assignee_id
           LEFT JOIN teams tm ON tm.id = t.team_id
           ${where}
          ORDER BY ${sortField} ${sortDir}, t.number DESC
          LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        values,
      )
      return { rows, total }
    })

    return {
      tickets: tickets.rows,
      total: tickets.total,
      nextCursor: null,
    }
  })

  app.post('/tickets', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)

    const defaults = await ensureTenantDefaults(app.db, ctx.tenantId)
    const policy = await getDefaultSlaPolicy(app.db, ctx.tenantId)
    const priority = body.priority ?? 'p3'
    const { dueResponseAt, dueResolutionAt } = computeDeadlines({
      priority,
      matrix: policy.matrix,
      schedule: policy.businessHoursSchedule,
    })

    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      const counter = await client.query(
        'UPDATE tenants SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter',
        [ctx.tenantId],
      )
      const number = counter.rows[0].ticket_counter as number
      await ensureDeviceBelongsToTenant(client, body.deviceId)

      const type = body.type ?? 'incident'

      // Resolve an optional catalogue service; validate it belongs to the tenant.
      let service: { id: string; name: string; approval_required: boolean } | null = null
      if (body.serviceId) {
        const svc = await client.query('SELECT id, name, approval_required FROM services WHERE id = $1 AND tenant_id = $2', [body.serviceId, ctx.tenantId])
        if (!svc.rows[0]) throw AppError.badRequest('Service not found in this tenant', 'service_not_found')
        service = svc.rows[0]
      }

      // Problem/change specifics live in tickets.ext.
      const ext: Record<string, unknown> = {}
      if (body.rootCause !== undefined) ext.rootCause = body.rootCause
      if (body.workaround !== undefined) ext.workaround = body.workaround
      if (body.risk !== undefined) ext.risk = body.risk
      if (body.implementationPlan !== undefined) ext.implementationPlan = body.implementationPlan
      if (body.backoutPlan !== undefined) ext.backoutPlan = body.backoutPlan
      if (body.scheduledAt !== undefined) ext.scheduledAt = body.scheduledAt
      // Requester details
      if (body.requesterName) ext.requesterName = body.requesterName
      if (body.requesterEmail) ext.requesterEmail = body.requesterEmail
      if (body.requesterPhone) ext.requesterPhone = body.requesterPhone
      if (body.requesterDepartment) ext.requesterDepartment = body.requesterDepartment
      if (body.requesterCompany) ext.requesterCompany = body.requesterCompany
      if (body.requesterLocation) ext.requesterLocation = body.requesterLocation

      const res = await client.query(
        `INSERT INTO tickets
           (tenant_id, number, type, status, priority, subject, requester_id, affected_user_id,
            assignee_id, team_id, category_id, device_id, service_id, sla_policy_id, source, ext, due_response_at, due_resolution_at)
         VALUES ($1, $2, $3, 'new', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'technician', $14::jsonb, $15, $16)
         RETURNING *`,
        [
          ctx.tenantId, number, type, priority, body.subject,
          request.user!.id, body.affectedUserId ?? null, body.assigneeId ?? null,
          body.teamId ?? defaults.teamId, body.categoryId ?? defaults.categoryId,
          body.deviceId ?? null, service?.id ?? null, policy.id, JSON.stringify(ext), dueResponseAt, dueResolutionAt,
        ],
      )
      const ticket = res.rows[0]

      if (service?.approval_required) {
        await requestServiceApproval(client, ctx.tenantId, {
          ticketId: ticket.id,
          ticketNumber: number,
          serviceName: service.name,
          requesterId: request.user!.id,
        })
        await client.query(
          `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
           VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
          [ctx.tenantId, ticket.id, `Service request from the "${service.name}" catalogue is awaiting approval.`, JSON.stringify({ event: 'service.approval_requested' })],
        )
      }

      if (type === 'change') {
        await requestChangeApproval(client, ctx.tenantId, {
          ticketId: ticket.id,
          ticketNumber: number,
          subject: body.subject,
          requesterId: request.user!.id,
        })
        await client.query(
          `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
           VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
          [ctx.tenantId, ticket.id, 'Change request is awaiting approval.', JSON.stringify({ event: 'change.approval_requested' })],
        )
      }

      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
         VALUES ($1, $2, $3, 'message', 'public', $4)`,
        [ctx.tenantId, ticket.id, request.user!.id, body.description ?? body.subject],
      )
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'ticket.created',
        objectType: 'ticket',
        objectId: ticket.id,
        ip: request.ip,
        payload: { number, subject: body.subject, priority },
      })

      // Run matching automation rules inside the same transaction so actions
      // (priority, tags, assignment, notes, notifications) apply atomically.
      await runAutomationsForTrigger(client, ctx.tenantId, 'ticket.created', {
        objectType: 'ticket',
        objectId: ticket.id,
        fields: {
          number,
          subject: body.subject,
          priority,
          type: body.type ?? 'incident',
          source: 'technician',
          status: 'new',
        },
      })
      // Re-read so automation-applied changes (priority, tags, assignment) are
      // reflected in the response.
      const updated = await client.query('SELECT * FROM tickets WHERE id = $1', [ticket.id])
      return updated.rows[0]
    })

    // Fire-and-forget webhook fan-out (Teams/Slack). Delivery failures never
    // fail ticket creation; the delivery log records attempts + outcome.
    void emitWebhookEvent(app.db, ctx.tenantId, 'ticket.created', {
      number: created.number,
      subject: body.subject,
      priority: created.priority,
      type: created.type,
      status: created.status,
    }, app.config.emailKey, app.webhookHttp).catch((err) => {
      request.log.warn({ err, tenantId: ctx.tenantId }, 'webhook fan-out failed')
    })

    return reply.code(201).send({ ticket: created })
  })

  app.get('/tickets/:id', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = await findTicket(client, id)
      if (!ticket) throw AppError.notFound('Ticket not found')
      const device = ticket.device_id
        ? (await client.query(
            `SELECT id, name, hostname, os, os_version, arch, ip_address, agent_version, last_seen_at
               FROM devices WHERE id = $1`,
            [ticket.device_id],
          )).rows[0] ?? null
        : null
      const threads = await client.query(
        `SELECT th.*, u.name AS author_name
           FROM ticket_threads th
           LEFT JOIN users u ON u.id = th.author_id
          WHERE th.ticket_id = $1
          ORDER BY th.created_at ASC`,
        [id],
      )
      return { ticket, device, threads: threads.rows }
    })
    return result
  })

  app.patch('/tickets/:id', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = await findTicket(client, id)
      if (!ticket) throw AppError.notFound('Ticket not found')

      const sets: string[] = []
      const values: unknown[] = []
      const changes: Record<string, { from: unknown; to: unknown }> = {}
      const fields = ['subject', 'priority', 'impact', 'urgency', 'type', 'categoryId', 'teamId', 'deviceId', 'tags'] as const
      const columns: Record<string, string> = { categoryId: 'category_id', teamId: 'team_id', deviceId: 'device_id' }
      await ensureDeviceBelongsToTenant(client, body.deviceId)
      for (const field of fields) {
        const value = body[field]
        if (value === undefined) continue
        const column = columns[field] ?? field
        values.push(value)
        sets.push(`${column} = $${values.length}`)
        changes[field] = { from: ticket[column], to: value }
      }

      // Problem/change specifics merge into tickets.ext (null/empty clears a key).
      const extFields = ['rootCause', 'workaround', 'risk', 'implementationPlan', 'backoutPlan', 'scheduledAt'] as const
      const extUpdates: Record<string, unknown> = {}
      for (const field of extFields) {
        if (body[field] === undefined) continue
        extUpdates[field] = body[field]
      }
      if (Object.keys(extUpdates).length > 0) {
        const merged: Record<string, unknown> = { ...(ticket.ext ?? {}) }
        for (const [k, v] of Object.entries(extUpdates)) {
          if (v === null || v === '') delete merged[k]
          else merged[k] = v
        }
        values.push(JSON.stringify(merged))
        sets.push(`ext = $${values.length}::jsonb`)
        changes.ext = { from: ticket.ext ?? {}, to: merged }
      }

      if (sets.length === 0) throw AppError.badRequest('Nothing to update')

      values.push(id)
      const res = await client.query(
        `UPDATE tickets SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
        values,
      )
      await logSystemEvent(client, ctx.tenantId, id, 'Ticket updated', { event: 'ticket.updated', changes })
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'ticket.updated',
        objectType: 'ticket',
        objectId: id,
        ip: request.ip,
        payload: { changes },
      })
      return { ticket: res.rows[0] }
    })
  })

  app.post('/tickets/:id/reply', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = replySchema.parse(request.body)
    const internal = body.visibility === 'internal'

    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = await findTicket(client, id)
      if (!ticket) throw AppError.notFound('Ticket not found')

      const res = await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [ctx.tenantId, id, request.user!.id, internal ? 'internal_note' : 'message', internal ? 'internal' : 'public', body.body],
      )

      if (!internal && !ticket.first_response_at) {
        await client.query(
          `UPDATE tickets SET first_response_at = now(), status = CASE WHEN status = 'new' THEN 'open' ELSE status END, updated_at = now() WHERE id = $1`,
          [id],
        )
        if (ticket.status === 'new') {
          await logSystemEvent(client, ctx.tenantId, id, 'Status changed: new → open', { event: 'ticket.status', from: 'new', to: 'open' })
        }
      }

      if (!internal) {
        const requester = (await client.query('SELECT email, name FROM users WHERE id = $1', [ticket.requester_id])).rows[0]
        await notify(client, ctx.tenantId, {
          userId: ticket.requester_id,
          kind: 'ticket.replied',
          subjectType: 'ticket',
          subjectId: id,
          body: `New reply on #${ticket.number} — ${ticket.subject}`,
        })
        return {
          thread: res.rows[0],
          mail: requester
            ? { to: requester.email, ticketNumber: ticket.number, subject: ticket.subject }
            : null,
        }
      }
      return { thread: res.rows[0], mail: null }
    })

    if (result.mail) {
      await app.mailer.sendReplyEmail({
        to: result.mail.to,
        ticketNumber: result.mail.ticketNumber,
        subject: result.mail.subject,
        body: body.body,
        tenantName: ctx.name,
      })
    }
    return reply.code(201).send({ thread: result.thread })
  })

  app.post('/tickets/:id/status', { preHandler: [...guards, requirePermission('ticket.resolve')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { status } = statusSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = await findTicket(client, id)
      if (!ticket) throw AppError.notFound('Ticket not found')
      if (ticket.status === status) return { ticket }

      const res = await client.query(
        `UPDATE tickets
            SET status = $2,
                resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN COALESCE(resolved_at, now()) ELSE NULL END,
                closed_at = CASE WHEN $2 = 'closed' THEN now() ELSE NULL END,
                updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, status],
      )
      await logSystemEvent(client, ctx.tenantId, id, `Status changed: ${ticket.status} → ${status}`, { event: 'ticket.status', from: ticket.status, to: status })
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: status === 'resolved' ? 'ticket.resolved' : 'ticket.status_changed',
        objectType: 'ticket',
        objectId: id,
        ip: request.ip,
        payload: { from: ticket.status, to: status },
      })

      const resolvedByStaff = status === 'resolved' || status === 'closed'
      if (resolvedByStaff && request.user!.id !== ticket.requester_id) {
        const requester = (await client.query('SELECT email FROM users WHERE id = $1', [ticket.requester_id])).rows[0]
        await notify(client, ctx.tenantId, {
          userId: ticket.requester_id,
          kind: 'ticket.resolved',
          subjectType: 'ticket',
          subjectId: id,
          body: `Ticket #${ticket.number} — ${ticket.subject} is ${status}`,
        })
        if (requester) {
          await app.mailer.sendResolvedEmail({
            to: requester.email,
            ticketNumber: ticket.number,
            subject: ticket.subject,
            body: `Your request #${ticket.number} has been marked ${status} by the support team.`,
            tenantName: ctx.name,
          })
        }
      }
      return { ticket: res.rows[0] }
    })
  })

  app.post('/tickets/:id/assign', { preHandler: [...guards, requirePermission('ticket.assign')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = assignSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = await findTicket(client, id)
      if (!ticket) throw AppError.notFound('Ticket not found')

      const res = await client.query(
        `UPDATE tickets SET assignee_id = $2, team_id = $3, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, body.assigneeId ?? null, body.teamId ?? ticket.team_id],
      )
      const assignee = body.assigneeId
        ? (await client.query('SELECT name FROM users WHERE id = $1', [body.assigneeId])).rows[0]?.name ?? 'unknown'
        : 'nobody'
      await logSystemEvent(client, ctx.tenantId, id, `Assigned to ${assignee}`, { event: 'ticket.assigned', assigneeId: body.assigneeId ?? null })
      return { ticket: res.rows[0] }
    })
  })
}
