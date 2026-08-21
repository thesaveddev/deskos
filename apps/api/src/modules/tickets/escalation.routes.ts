import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { withTenant } from '../../db/pool.js'
import {
  listEscalationPolicies, createEscalationPolicy, updateEscalationPolicy, deleteEscalationPolicy,
  listEscalationPaths, createEscalationPath, updateEscalationPath, deleteEscalationPath, matchEscalationPaths,
  escalateTicket, getTicketEscalations,
  forwardTicket, mergeTickets,
  listActivity,
  bulkUpdateTickets,
} from './escalation.service.js'

export async function escalationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  // ── Escalation policies ──

  app.get('/escalation-policies', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const policies = await withTenant(app.db, ctx.tenantId, (client) => listEscalationPolicies(client, ctx.tenantId))
    return reply.send({ policies })
  })

  app.post('/escalation-policies', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as Record<string, unknown>
    const policy = await withTenant(app.db, ctx.tenantId, (client) => createEscalationPolicy(client, ctx.tenantId, body as any))
    return reply.code(201).send({ policy })
  })

  app.patch('/escalation-policies/:id', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as Record<string, unknown>
    const policy = await withTenant(app.db, ctx.tenantId, (client) => updateEscalationPolicy(client, ctx.tenantId, Number(id), body as any))
    if (!policy) return reply.code(404).send({ error: 'Policy not found' })
    return reply.send({ policy })
  })

  app.delete('/escalation-policies/:id', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const deleted = await withTenant(app.db, ctx.tenantId, (client) => deleteEscalationPolicy(client, ctx.tenantId, Number(id)))
    if (!deleted) return reply.code(404).send({ error: 'Policy not found' })
    return reply.send({ ok: true })
  })

  // ── Escalation paths (manual routing rules) ──

  app.get('/escalation-paths', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const paths = await withTenant(app.db, ctx.tenantId, (client) => listEscalationPaths(client, ctx.tenantId))
    return reply.send({ paths })
  })

  app.post('/escalation-paths', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as Record<string, unknown>
    try {
      const path = await withTenant(app.db, ctx.tenantId, (client) => createEscalationPath(client, ctx.tenantId, body as any))
      return reply.code(201).send({ path })
    } catch (e: any) {
      return reply.code(400).send({ error: e.message || 'Invalid escalation path' })
    }
  })

  app.patch('/escalation-paths/:id', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as Record<string, unknown>
    const path = await withTenant(app.db, ctx.tenantId, (client) => updateEscalationPath(client, ctx.tenantId, Number(id), body as any))
    if (!path) return reply.code(404).send({ error: 'Path not found' })
    return reply.send({ path })
  })

  app.delete('/escalation-paths/:id', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const deleted = await withTenant(app.db, ctx.tenantId, (client) => deleteEscalationPath(client, ctx.tenantId, Number(id)))
    if (!deleted) return reply.code(404).send({ error: 'Path not found' })
    return reply.send({ ok: true })
  })

  // Paths that match a ticket's current team / category / priority, so the
  // detail view can pre-fill the Escalate form in one click.
  app.get('/tickets/:id/escalation-paths', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const paths = await withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = (await client.query(
        'SELECT team_id, category_id, priority FROM tickets WHERE id = $1 AND tenant_id = $2',
        [id, ctx.tenantId],
      )).rows[0]
      if (!ticket) return null
      return matchEscalationPaths(client, ctx.tenantId, {
        team_id: ticket.team_id,
        category_id: ticket.category_id,
        priority: ticket.priority,
      })
    })
    if (paths === null) return reply.code(404).send({ error: 'Ticket not found' })
    return reply.send({ paths })
  })

  // ── Escalate a ticket ──

  app.post('/tickets/:id/escalate', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as { to_team_id?: string; to_assignee_id?: string; reason: string }
    if (!body.reason) return reply.code(400).send({ error: 'reason is required' })
    try {
      const escalation = await withTenant(app.db, ctx.tenantId, (client) => escalateTicket(client, ctx.tenantId, id, ctx.userId, body))
      return reply.code(201).send({ escalation })
    } catch (e: any) {
      return reply.code(404).send({ error: e.message || 'Ticket not found' })
    }
  })

  app.get('/tickets/:id/escalations', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const escalations = await withTenant(app.db, ctx.tenantId, (client) => getTicketEscalations(client, ctx.tenantId, id))
    return reply.send({ escalations })
  })

  // ── Forward ticket ──

  app.post('/tickets/:id/forward', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as { to_team_id?: string; to_assignee_id?: string; note?: string }
    try {
      await withTenant(app.db, ctx.tenantId, (client) => forwardTicket(client, ctx.tenantId, id, ctx.userId, body))
      return reply.send({ ok: true })
    } catch (e: any) {
      return reply.code(404).send({ error: e.message || 'Ticket not found' })
    }
  })

  // ── Merge tickets ──

  app.post('/tickets/merge', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { primary_id: string; duplicate_ids: string[] }
    if (!body.primary_id || !body.duplicate_ids?.length) {
      return reply.code(400).send({ error: 'primary_id and duplicate_ids are required' })
    }
    await withTenant(app.db, ctx.tenantId, (client) => mergeTickets(client, ctx.tenantId, body.primary_id, body.duplicate_ids, ctx.userId))
    return reply.send({ ok: true })
  })

  // ── Bulk update ──

  app.post('/tickets/bulk', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { ticket_ids: string[]; status?: string; assignee_id?: string; team_id?: string; priority?: string }
    if (!body.ticket_ids?.length) return reply.code(400).send({ error: 'ticket_ids is required' })
    const count = await withTenant(app.db, ctx.tenantId, (client) => bulkUpdateTickets(client, ctx.tenantId, body.ticket_ids, ctx.userId, {
      status: body.status,
      assignee_id: body.assignee_id,
      team_id: body.team_id,
      priority: body.priority,
    }))
    return reply.send({ updated: count })
  })

  // ── Activity log ──

  app.get('/tickets/:id/activity', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const activity = await withTenant(app.db, ctx.tenantId, (client) => listActivity(client, ctx.tenantId, id))
    return reply.send({ activity })
  })
}
