import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const serviceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  categoryId: z.string().uuid().optional(),
  slaPolicyId: z.string().uuid().optional(),
  approvalRequired: z.boolean().default(false),
  enabled: z.boolean().default(true),
  formFields: z.array(z.record(z.unknown())).max(50).default([]),
})

const serviceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  categoryId: z.string().uuid().nullable().optional(),
  slaPolicyId: z.string().uuid().nullable().optional(),
  approvalRequired: z.boolean().optional(),
  enabled: z.boolean().optional(),
  formFields: z.array(z.record(z.unknown())).max(50).optional(),
})

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().trim().max(2000).optional(),
})

async function ensureCategoryInTenant(client: DbClient, tenantId: string, categoryId: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM categories WHERE id = $1 AND tenant_id = $2', [categoryId, tenantId])
  if (!rows[0]) throw AppError.badRequest('Category not found in this tenant', 'category_not_found')
}

export async function catalogueRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('catalogue.read')]
  const write = [authenticate, requireTenant, requirePermission('catalogue.manage')]

  // ---- Service catalogue --------------------------------------------------
  app.get('/services', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { enabled } = request.query as { enabled?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      if (enabled === 'true' || enabled === 'false') {
        values.push(enabled === 'true')
        clauses.push(`s.enabled = $${values.length}`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const res = await client.query(
        `SELECT s.*, c.name AS category_name
           FROM services s
           LEFT JOIN categories c ON c.id = s.category_id
           ${where}
          ORDER BY s.name ASC LIMIT 200`,
        values,
      )
      return { services: res.rows }
    })
  })

  app.post('/services', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = serviceCreateSchema.parse(request.body)
    const service = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.categoryId) await ensureCategoryInTenant(client, ctx.tenantId, body.categoryId)
      const res = await client.query(
        `INSERT INTO services (tenant_id, name, description, category_id, sla_policy_id, approval_required, enabled, form_fields)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
        [
          ctx.tenantId, body.name, body.description, body.categoryId ?? null,
          body.slaPolicyId ?? null, body.approvalRequired, body.enabled, JSON.stringify(body.formFields),
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'service.created',
        objectType: 'service',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { name: body.name },
      })
      return res.rows[0]
    })
    return reply.code(201).send({ service })
  })

  app.get('/services/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, c.name AS category_name FROM services s LEFT JOIN categories c ON c.id = s.category_id WHERE s.id = $1`,
        [id],
      )
      if (!rows[0]) throw AppError.notFound('Service not found')
      return { service: rows[0] }
    })
  })

  app.patch('/services/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = serviceUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM services WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Service not found')
      if (body.categoryId) await ensureCategoryInTenant(client, ctx.tenantId, body.categoryId)

      const res = await client.query(
        `UPDATE services SET
           name = $2, description = $3, category_id = $4, sla_policy_id = $5,
           approval_required = $6, enabled = $7, form_fields = $8::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          body.name ?? current.name,
          body.description ?? current.description,
          body.categoryId === undefined ? current.category_id : body.categoryId,
          body.slaPolicyId === undefined ? current.sla_policy_id : body.slaPolicyId,
          body.approvalRequired ?? current.approval_required,
          body.enabled ?? current.enabled,
          JSON.stringify(body.formFields ?? current.form_fields),
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'service.updated',
        objectType: 'service',
        objectId: id,
        ip: request.ip,
      })
      return { service: res.rows[0] }
    })
  })

  app.delete('/services/:id', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM services WHERE id = $1 RETURNING id', [id])
      if (!res.rows[0]) throw AppError.notFound('Service not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'service.deleted',
        objectType: 'service',
        objectId: id,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })

  // ---- Approvals ----------------------------------------------------------
  app.get('/approvals/mine', { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT a.id, a.ticket_id, a.status, a.note, a.created_at, a.decided_at,
                t.number, t.subject, t.type, u.name AS requested_by_name
           FROM ticket_approvals a
           JOIN tickets t ON t.id = a.ticket_id
           LEFT JOIN users u ON u.id = a.requested_by
          WHERE a.approver_id = $1 AND a.status = 'pending'
          ORDER BY a.created_at ASC LIMIT 100`,
        [userId],
      )
      return { approvals: res.rows }
    })
  })

  app.get('/tickets/:id/approvals', { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT a.*, u.name AS approver_name
           FROM ticket_approvals a
           LEFT JOIN users u ON u.id = a.approver_id
          WHERE a.ticket_id = $1 ORDER BY a.created_at ASC`,
        [id],
      )
      return { approvals: res.rows }
    })
  })

  app.post('/tickets/:id/approvals/:aid/decide', { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, aid } = request.params as { id: string; aid: string }
    const body = decideSchema.parse(request.body)
    const approval = await withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM ticket_approvals WHERE id = $1 AND ticket_id = $2', [aid, id])).rows[0]
      if (!current) throw AppError.notFound('Approval not found')
      if (current.approver_id !== request.user!.id) throw AppError.forbidden('Only the assigned approver may decide', 'not_approver')
      if (current.status !== 'pending') throw AppError.badRequest('Approval already decided', 'already_decided')

      const res = await client.query(
        `UPDATE ticket_approvals SET status = $2, decided_at = now(), note = $3, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [aid, body.decision, body.note ?? current.note],
      )

      const ticket = (await client.query('SELECT number, subject, requester_id FROM tickets WHERE id = $1', [id])).rows[0]
      const verb = body.decision === 'approved' ? 'approved' : 'rejected'
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
         VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
        [
          ctx.tenantId, id,
          `Service request #${ticket.number} ${verb} by ${request.user!.name}${body.note ? ` — ${body.note}` : ''}.`,
          JSON.stringify({ event: 'service.approval', decision: body.decision }),
        ],
      )
      if (ticket.requester_id) {
        await notify(client, ctx.tenantId, {
          userId: ticket.requester_id,
          kind: 'service.approval_decided',
          subjectType: 'ticket',
          subjectId: id,
          body: `Service request #${ticket.number} (${ticket.subject}) was ${verb}${body.note ? `: ${body.note}` : ''}`,
        })
      }
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: `approval.${body.decision}`,
        objectType: 'ticket_approval',
        objectId: aid,
        ip: request.ip,
        payload: { ticketId: id, note: body.note },
      })
      return res.rows[0]
    })
    return { approval }
  })
}
