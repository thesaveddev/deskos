import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { fleetDex, getDeviceDex, recomputeDevice } from './dex.js'
import '../../types.js'

export async function dexRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('rmm.read')]
  const manage = [authenticate, requireTenant, requirePermission('rmm.manage')]

  app.get('/devices/:id/dex', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return getDeviceDex(app.db, ctx.tenantId, id)
  })

  app.get('/dex/fleet', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return fleetDex(app.db, ctx.tenantId)
  })

  app.post('/devices/:id/dex/recompute', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return recomputeDevice(app.db, ctx.tenantId, id)
  })
}
