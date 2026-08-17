import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import {
  listEscalationPolicies, createEscalationPolicy, updateEscalationPolicy, deleteEscalationPolicy,
  escalateTicket, getTicketEscalations,
  forwardTicket, mergeTickets,
  listActivity,
  bulkUpdateTickets,
  listTeams, listTeamMembers,
} from './escalation.service.js'

export async function escalationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)
  app.addHook('preHandler', requireTenant)

  // ── Escalation policies ──

  app.get('/escalation-policies', { preHandler: requirePermission('ticket.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const policies = await listEscalationPolicies(app.db, ctx.tenantId)
    return reply.send({ policies })
  })

  app.post('/escalation-policies', { preHandler: requirePermission('ticket.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as Record<string, unknown>
    const policy = await createEscalationPolicy(app.db, ctx.tenantId, body as any)
    return reply.code(201).send({ policy })
  })

  app.patch('/escalation-policies/:id', { preHandler: requirePermission('ticket.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as Record<string, unknown>
    const policy = await updateEscalationPolicy(app.db, ctx.tenantId, Number(id), body as any)
    if (!policy) return reply.code(404).send({ error: 'Policy not found' })
    return reply.send({ policy })
  })

  app.delete('/escalation-policies/:id', { preHandler: requirePermission('ticket.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const deleted = await deleteEscalationPolicy(app.db, ctx.tenantId, Number(id))
    if (!deleted) return reply.code(404).send({ error: 'Policy not found' })
    return reply.send({ ok: true })
  })

  // ── Escalate a ticket ──

  app.post('/tickets/:id/escalate', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as { to_team_id?: string; to_assignee_id?: string; reason: string }
    if (!body.reason) return reply.code(400).send({ error: 'reason is required' })
    try {
      const escalation = await escalateTicket(app.db, ctx.tenantId, id, ctx.userId, body)
      return reply.code(201).send({ escalation })
    } catch (e: any) {
      return reply.code(404).send({ error: e.message || 'Ticket not found' })
    }
  })

  app.get('/tickets/:id/escalations', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const escalations = await getTicketEscalations(app.db, ctx.tenantId, id)
    return reply.send({ escalations })
  })

  // ── Forward ticket ──

  app.post('/tickets/:id/forward', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as { to_team_id?: string; to_assignee_id?: string; note?: string }
    try {
      await forwardTicket(app.db, ctx.tenantId, id, ctx.userId, body)
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
    await mergeTickets(app.db, ctx.tenantId, body.primary_id, body.duplicate_ids, ctx.userId)
    return reply.send({ ok: true })
  })

  // ── Bulk update ──

  app.post('/tickets/bulk', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as { ticket_ids: string[]; status?: string; assignee_id?: string; team_id?: string; priority?: string }
    if (!body.ticket_ids?.length) return reply.code(400).send({ error: 'ticket_ids is required' })
    const count = await bulkUpdateTickets(app.db, ctx.tenantId, body.ticket_ids, ctx.userId, {
      status: body.status,
      assignee_id: body.assignee_id,
      team_id: body.team_id,
      priority: body.priority,
    })
    return reply.send({ updated: count })
  })

  // ── Activity log ──

  app.get('/tickets/:id/activity', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const activity = await listActivity(app.db, ctx.tenantId, id)
    return reply.send({ activity })
  })

  // ── Teams list (for forwarding/escalation UI) ──

  app.get('/teams', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const teams = await listTeams(app.db, ctx.tenantId)
    return reply.send({ teams })
  })

  app.get('/teams/:id/members', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const members = await listTeamMembers(app.db, ctx.tenantId, id)
    return reply.send({ members })
  })
}
