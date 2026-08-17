import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticateAgent } from '../devices/device-auth.js'
import { recomputeDevice } from '../dex/dex.js'
import {
  createActions,
  createPolicy,
  deletePolicy,
  DEVICE_ACTIONS,
  getInventory,
  listActions,
  listPolicies,
  pendingActionsForDevice,
  reportActionResult,
  updatePolicy,
  upsertInventory,
  type PolicyInput,
} from './rmm.js'
import '../../types.js'

const inventorySchema = z.object({
  hardware: z.record(z.unknown()).optional(),
  os: z.record(z.unknown()).optional(),
  apps: z.array(z.unknown()).optional(),
  securityPosture: z.record(z.unknown()).optional(),
})

const policySchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: z.string().uuid().nullable().optional(),
  postureChecks: z.array(z.unknown()).optional(),
  rebootWindow: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
})

const policyUpdateSchema = policySchema.partial()

const actionsSchema = z.object({
  action: z.enum(DEVICE_ACTIONS),
  payload: z.record(z.unknown()).optional(),
  deviceIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  groupId: z.string().uuid().optional(),
})

const actionResultSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  result: z.record(z.unknown()).optional(),
})

export async function rmmRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('rmm.read')]
  const manage = [authenticate, requireTenant, requirePermission('rmm.manage')]

  // -- Inventory -----------------------------------------------------------
  app.get('/devices/:id/inventory', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { inventory: await getInventory(app.db, ctx.tenantId, id) }
  })

  app.post('/agent/inventory', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const body = inventorySchema.parse(request.body)
    const inventory = await upsertInventory(app.db, ctx.tenantId, ctx.deviceId, body)
    // Recompute DEX/posture against the fresh posture report (best-effort).
    try {
      await recomputeDevice(app.db, ctx.tenantId, ctx.deviceId)
    } catch (err) {
      request.log.warn({ err, deviceId: ctx.deviceId }, 'dex recompute after inventory failed')
    }
    return { ok: true, inventory }
  })

  // -- Policies ------------------------------------------------------------
  app.get('/endpoint-policies', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { policies: await listPolicies(app.db, ctx.tenantId) }
  })

  app.post('/endpoint-policies', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = policySchema.parse(request.body)
    const policy = await createPolicy(app.db, ctx.tenantId, body as PolicyInput, request.user!.id)
    return reply.code(201).send({ policy })
  })

  app.patch('/endpoint-policies/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = policyUpdateSchema.parse(request.body)
    const policy = await updatePolicy(app.db, ctx.tenantId, id, body as Partial<PolicyInput>)
    return { policy }
  })

  app.delete('/endpoint-policies/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deletePolicy(app.db, ctx.tenantId, id)
    return { ok: true }
  })

  // -- Bulk actions ----------------------------------------------------------
  app.post('/devices/actions', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = actionsSchema.parse(request.body)
    const result = await createActions(app.db, ctx.tenantId, body, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'rmm.actions_queued',
        objectType: 'device_action',
        objectId: null,
        ip: request.ip,
        payload: { action: body.action, created: result.created },
      })
    })
    return reply.code(201).send(result)
  })

  app.get('/devices/actions', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { status, deviceId } = request.query as Record<string, string | undefined>
    return { actions: await listActions(app.db, ctx.tenantId, { status: status as never, deviceId }) }
  })

  app.get('/agent/actions/pending', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    return { actions: await pendingActionsForDevice(app.db, ctx.tenantId, ctx.deviceId) }
  })

  app.post('/agent/actions/:id/result', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = actionResultSchema.parse(request.body)
    const action = await reportActionResult(app.db, ctx.tenantId, id, ctx.deviceId, body)
    return { action }
  })
}
