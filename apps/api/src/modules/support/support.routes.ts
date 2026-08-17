import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import {
  createSupportTicket, listSupportTickets, getSupportTicket, updateSupportTicket,
  addSupportTicketThread, getSupportTicketThreads,
  getPlatformMetrics, listOrganizations,
} from './support.js'
import '../../types.js'

const createSchema = z.object({
  subject: z.string().min(3).max(300),
  description: z.string().max(20_000).optional(),
  category: z.enum(['general', 'bug', 'feature_request', 'billing', 'security', 'other']).default('general'),
  priority: z.enum(['p1', 'p2', 'p3', 'p4']).default('p3'),
})

const replySchema = z.object({ body: z.string().min(1).max(20_000) })

const updateSchema = z.object({
  status: z.enum(['open', 'in_progress', 'waiting_user', 'resolved', 'closed']).optional(),
  priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
  assigned_to: z.string().uuid().nullable().optional(),
})

/**
 * Support routes — /api/v1/support/*
 * Public routes for any authenticated user to submit DeskOS product issues.
 * Admin routes for platform operators to manage support tickets and view metrics.
 */
export async function supportRoutes(app: FastifyInstance): Promise<void> {
  // ---- User-facing support routes ----

  /** List my support tickets */
  app.get('/support/tickets', { preHandler: [authenticate] }, async (request) => {
    const tickets = await listSupportTickets(app.db, { userId: request.user!.id })
    return { tickets }
  })

  /** Submit a new support ticket */
  app.post('/support/tickets', { preHandler: [authenticate] }, async (request, reply) => {
    const body = createSchema.parse(request.body)
    const tenantId = request.tenantCtx?.tenantId ?? null
    const ticket = await createSupportTicket(app.db, request.user!.id, tenantId, body)
    return reply.code(201).send({ ticket })
  })

  /** Get a support ticket (own tickets or admin) */
  app.get('/support/tickets/:id', { preHandler: [authenticate] }, async (request) => {
    const { id } = request.params as { id: string }
    const ticket = await getSupportTicket(app.db, Number(id))
    if (!ticket) throw AppError.notFound('Support ticket not found')
    // Only the ticket author or platform admin can view
    const isAdmin = (request.user as any)?.is_platform_admin
    if (ticket.user_id !== request.user!.id && !isAdmin) {
      throw AppError.forbidden('Access denied')
    }
    const threads = await getSupportTicketThreads(app.db, ticket.id)
    return { ticket, threads }
  })

  /** Reply to a support ticket */
  app.post('/support/tickets/:id/reply', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = replySchema.parse(request.body)
    const ticket = await getSupportTicket(app.db, Number(id))
    if (!ticket) throw AppError.notFound('Support ticket not found')
    const isAdmin = (request.user as any)?.is_platform_admin
    if (ticket.user_id !== request.user!.id && !isAdmin) {
      throw AppError.forbidden('Access denied')
    }
    const thread = await addSupportTicketThread(app.db, ticket.id, request.user!.id, 'message', body.body)
    // Auto-reopen if resolved
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
      await updateSupportTicket(app.db, ticket.id, { status: 'open' })
    }
    return reply.code(201).send({ thread })
  })

  // ---- Admin routes ----

  /** Platform metrics dashboard */
  app.get('/admin/metrics', { preHandler: [authenticate] }, async (request) => {
    const isAdmin = (request.user as any)?.is_platform_admin
    if (!isAdmin) throw AppError.forbidden('Platform admin access required')
    const metrics = await getPlatformMetrics(app.db)
    return metrics
  })

  /** List all organizations */
  app.get('/admin/orgs', { preHandler: [authenticate] }, async (request) => {
    const isAdmin = (request.user as any)?.is_platform_admin
    if (!isAdmin) throw AppError.forbidden('Platform admin access required')
    const orgs = await listOrganizations(app.db)
    return { orgs }
  })

  /** List all support tickets (admin) */
  app.get('/admin/support-tickets', { preHandler: [authenticate] }, async (request) => {
    const isAdmin = (request.user as any)?.is_platform_admin
    if (!isAdmin) throw AppError.forbidden('Platform admin access required')
    const { status } = request.query as { status?: string }
    const tickets = await listSupportTickets(app.db, { status })
    return { tickets }
  })

  /** Update a support ticket (admin — assign, resolve, change priority) */
  app.patch('/admin/support-tickets/:id', { preHandler: [authenticate] }, async (request) => {
    const isAdmin = (request.user as any)?.is_platform_admin
    if (!isAdmin) throw AppError.forbidden('Platform admin access required')
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    const ticket = await updateSupportTicket(app.db, Number(id), body)
    if (!ticket) throw AppError.notFound('Support ticket not found')
    return { ticket }
  })

  /** Admin reply to a support ticket (as internal note or message) */
  app.post('/admin/support-tickets/:id/reply', { preHandler: [authenticate] }, async (request, reply) => {
    const isAdmin = (request.user as any)?.is_platform_admin
    if (!isAdmin) throw AppError.forbidden('Platform admin access required')
    const { id } = request.params as { id: string }
    const body = z.object({
      body: z.string().min(1).max(20_000),
      kind: z.enum(['message', 'internal_note']).default('message'),
    }).parse(request.body)
    const ticket = await getSupportTicket(app.db, Number(id))
    if (!ticket) throw AppError.notFound('Support ticket not found')
    const thread = await addSupportTicketThread(app.db, ticket.id, request.user!.id, body.kind, body.body)
    return reply.code(201).send({ thread })
  })
}
