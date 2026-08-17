import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticateAgent } from '../devices/device-auth.js'
import {
  approveDeployment,
  createDeployment,
  DEVICE_PATCH_STATUSES,
  getDeployment,
  listDeployments,
  PATCH_STATUSES,
  pendingForDevice,
  rejectDeployment,
  reportDeviceStatus,
  rollbackDeployment,
  startDeployment,
  submitDeployment,
} from './patches.js'
import '../../types.js'

const ringSchema = z.object({ name: z.string().trim().min(1).max(60), percent: z.number().int().min(0).max(100) })

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  version: z.string().trim().min(1).max(60),
  description: z.string().max(4000).optional(),
  artifactUrl: z.string().trim().url().max(1000),
  sha256: z.string().trim().regex(/^[0-9a-fA-F]{64}$/),
  signature: z.string().trim().max(1000).optional(),
  channel: z.enum(['stable', 'beta']).optional(),
  scopeType: z.enum(['tenant', 'device_group']).optional(),
  scopeId: z.string().uuid().optional(),
  rings: z.array(ringSchema).min(1).max(10).optional(),
})

const deviceStatusSchema = z.object({
  status: z.enum(DEVICE_PATCH_STATUSES),
  detail: z.string().max(1000).optional(),
})

export async function patchRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('patch.read')]
  const manage = [authenticate, requireTenant, requirePermission('patch.manage')]
  const approve = [authenticate, requireTenant, requirePermission('patch.approve')]

  app.get('/patches', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { status } = request.query as Record<string, string | undefined>
    const patches = await listDeployments(app.db, ctx.tenantId, {
      status: status as (typeof PATCH_STATUSES)[number] | undefined,
    })
    return { patches }
  })

  app.post('/patches', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const patch = await createDeployment(app.db, ctx.tenantId, body, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'patch.created',
        objectType: 'patch_deployment',
        objectId: patch.id as string,
        ip: request.ip,
        payload: { name: body.name, version: body.version, channel: body.channel ?? 'stable' },
      })
    })
    return reply.code(201).send({ patch })
  })

  app.get('/patches/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return getDeployment(app.db, ctx.tenantId, id)
  })

  app.post('/patches/:id/submit', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const patch = await submitDeployment(app.db, ctx.tenantId, id)
    return { patch }
  })

  app.post('/patches/:id/approve', { preHandler: approve }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const patch = await approveDeployment(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'patch.approved',
        objectType: 'patch_deployment',
        objectId: id,
        ip: request.ip,
        payload: { name: patch.name as string, version: patch.version as string },
      })
    })
    return { patch }
  })

  app.post('/patches/:id/reject', { preHandler: approve }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const patch = await rejectDeployment(app.db, ctx.tenantId, id, request.user!.id)
    return { patch }
  })

  app.post('/patches/:id/start', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const patch = await startDeployment(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'patch.rollout_started',
        objectType: 'patch_deployment',
        objectId: id,
        ip: request.ip,
        payload: { name: patch.name as string, version: patch.version as string },
      })
    })
    return { patch }
  })

  app.post('/patches/:id/rollback', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const patch = await rollbackDeployment(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'patch.rolled_back',
        objectType: 'patch_deployment',
        objectId: id,
        ip: request.ip,
        payload: { name: patch.name as string, version: patch.version as string },
      })
    })
    return { patch }
  })

  // -- Agent-facing --------------------------------------------------------
  app.get('/agent/patches', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    return { patches: await pendingForDevice(app.db, ctx.tenantId, ctx.deviceId) }
  })

  app.post('/agent/patches/:deploymentId/status', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const { deploymentId } = request.params as { deploymentId: string }
    const body = deviceStatusSchema.parse(request.body)
    const status = await reportDeviceStatus(app.db, ctx.tenantId, deploymentId, ctx.deviceId, body.status, body.detail ?? '')
    return { status }
  })
}
