import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { lockTicket, unlockTicket, heartbeatLock, getTicketLock } from './locks.service.js'

export async function ticketLockRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  // Get lock status for a ticket
  app.get('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const lock = await getTicketLock(app.db, ctx.tenantId, id)
    const isMine = lock?.locked_by === ctx.userId
    return reply.send({ lock, is_mine: isMine })
  })

  // Lock a ticket
  app.post('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const result = await lockTicket(app.db, ctx.tenantId, id, ctx.userId)
    if (!result.locked) {
      return reply.status(409).send({
        error: 'Ticket is locked by another agent',
        held_by: result.held_by,
      })
    }
    return reply.send({ lock: result.lock })
  })

  // Unlock a ticket
  app.delete('/tickets/:id/lock', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    await unlockTicket(app.db, ctx.tenantId, id, ctx.userId)
    return reply.send({ ok: true })
  })

  // Heartbeat (extend lock)
  app.post('/tickets/:id/lock/heartbeat', { preHandler: requirePermission('ticket.write') }, async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const extended = await heartbeatLock(app.db, ctx.tenantId, id, ctx.userId)
    return reply.send({ ok: extended })
  })
}
