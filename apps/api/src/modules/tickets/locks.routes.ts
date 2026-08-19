import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import {
  acquireTicketLock, getTicketLock, unlockTicket, forceUnlock, heartbeatLock,
  startViewing, stopViewing, heartbeatViewing, getViewers,
  listActiveTicketLocks, listLockReleaseRequests, requestTicketLockRelease, resolveLockReleaseRequest,
} from './locks.service.js'

export async function ticketLockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  // ── Lock endpoints ──

  const releaseRequestSchema = z.object({ message: z.string().trim().max(500).optional() })
  const releaseDecisionSchema = z.object({ decision: z.enum(['approve', 'deny']) })
  const canManageLocks = (role: string | undefined) => ['owner', 'it_manager', 'service_desk_manager'].includes(role ?? '')

  // Managers can review all active locks without opening each ticket.
  app.get('/tickets/locks', { preHandler: requirePermission('settings.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const locks = await listActiveTicketLocks(app.db, ctx.tenantId)
    return reply.send({ locks })
  })

  app.get('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const lock = await getTicketLock(app.db, ctx.tenantId, id)
    const isMine = lock?.locked_by === userId
    return reply.send({ lock, is_mine: isMine })
  })

  // Acquire or renew a lock. A second agent receives a clear conflict instead
  // of silently taking over the ticket.
  app.post('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const result = await acquireTicketLock(app.db, ctx.tenantId, id, userId)
    if (!result.lock) {
      return reply.code(409).send({
        error: {
          code: 'ticket_locked',
          message: 'This ticket is already being worked on by another agent.',
          details: result.conflict ? {
            locked_by: result.conflict.locked_by,
            locked_by_name: result.conflict.locked_by_name,
            locked_by_email: result.conflict.locked_by_email,
            expires_at: result.conflict.expires_at,
          } : undefined,
        },
      })
    }
    return reply.send({ lock: result.lock })
  })

  // Unlock (agent navigated away)
  app.delete('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    await unlockTicket(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: true })
  })

  // Request that the current lock owner release the ticket.
  app.post('/tickets/:id/lock/release-request', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const body = releaseRequestSchema.parse(req.body ?? {})
    try {
      const request = await requestTicketLockRelease(app.db, ctx.tenantId, id, userId, body.message ?? '')
      return reply.code(201).send({ request })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not request lock release'
      throw AppError.conflict(message, 'lock_release_request_failed')
    }
  })

  app.get('/tickets/:id/lock/release-requests', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const requests = await listLockReleaseRequests(app.db, ctx.tenantId, id, userId, canManageLocks(ctx.orgRole))
    return reply.send({ requests })
  })

  app.post('/tickets/:id/lock/release-requests/:requestId/resolve', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id, requestId } = req.params as { id: string; requestId: string }
    const body = releaseDecisionSchema.parse(req.body ?? {})
    try {
      const request = await resolveLockReleaseRequest(app.db, ctx.tenantId, id, requestId, userId, body.decision, canManageLocks(ctx.orgRole))
      return reply.send({ request })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not resolve lock release request'
      throw AppError.forbidden(message, 'lock_release_request_denied')
    }
  })

  // Force unlock (owner/IT manager/service desk manager only)
  app.delete('/tickets/:id/lock/force', { preHandler: requirePermission('settings.manage') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    await forceUnlock(app.db, ctx.tenantId, id)
    return reply.send({ ok: true })
  })

  // Heartbeat lock (while viewing)
  app.post('/tickets/:id/lock/heartbeat', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const extended = await heartbeatLock(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: extended })
  })

  // ── Viewing endpoints ──

  app.post('/tickets/:id/viewing', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    await startViewing(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: true })
  })

  app.delete('/tickets/:id/viewing', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    await stopViewing(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: true })
  })

  app.post('/tickets/:id/viewing/heartbeat', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    await heartbeatViewing(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: true })
  })

  app.get('/tickets/:id/viewers', { preHandler: requirePermission('ticket.read') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const viewers = await getViewers(app.db, ctx.tenantId, id)
    return reply.send({ viewers })
  })
}
