import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import {
  autoLockOnAssign, getTicketLock, unlockTicket, forceUnlock, heartbeatLock,
  startViewing, stopViewing, heartbeatViewing, getViewers,
} from './locks.service.js'

export async function ticketLockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  // ── Lock endpoints ──

  app.get('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    const lock = await getTicketLock(app.db, ctx.tenantId, id)
    const isMine = lock?.locked_by === userId
    return reply.send({ lock, is_mine: isMine })
  })

  // Acquire lock (create new or extend existing)
  app.post('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    // Try heartbeat first (extend existing lock)
    const extended = await heartbeatLock(app.db, ctx.tenantId, id, userId)
    if (extended) {
      const lock = await getTicketLock(app.db, ctx.tenantId, id)
      return reply.send({ lock })
    }
    // No existing lock — create a new one
    await autoLockOnAssign(app.db, ctx.tenantId, id, userId)
    const lock = await getTicketLock(app.db, ctx.tenantId, id)
    return reply.send({ lock })
  })

  // Unlock (agent navigated away)
  app.delete('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const userId = (req as any).user.id as string
    const { id } = req.params as { id: string }
    await unlockTicket(app.db, ctx.tenantId, id, userId)
    return reply.send({ ok: true })
  })

  // Force unlock (manager/admin only)
  app.delete('/tickets/:id/lock/force', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
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
