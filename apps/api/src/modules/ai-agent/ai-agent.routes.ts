import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { createAiProvider } from '../ai/gateway.js'
import { approveAndExecute, denyRemediation, listRemediations, proposeRemediation, REMEDIATION_STATUSES } from './agent.js'
import '../../types.js'

const signalSchema = z.object({
  sourceType: z.enum(['device_alert', 'posture_alert', 'dex', 'ticket']),
  sourceId: z.string().uuid().optional(),
  deviceId: z.string().uuid().optional(),
  kind: z.string().trim().max(80).optional(),
  checkPath: z.string().trim().max(160).optional(),
  ticketId: z.string().uuid().optional(),
})

const statusSchema = z.object({
  status: z.enum(REMEDIATION_STATUSES).optional(),
})

export async function aiAgentRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ai_agent.read')]
  const manage = [authenticate, requireTenant, requirePermission('ai_agent.manage')]
  const providerFor = () => app.aiProvider ?? createAiProvider(app.config.ai)

  app.get('/ai-agent/remediations', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = statusSchema.parse(request.query)
    return { remediations: await listRemediations(app.db, ctx.tenantId, { status: query.status }) }
  })

  app.post('/ai-agent/remediations', { preHandler: read }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = signalSchema.parse(request.body)
    const remediation = await proposeRemediation(app.db, ctx.tenantId, body, providerFor(), app.config.ai.model)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_agent.remediation_proposed',
        objectType: 'ai_remediation',
        objectId: remediation.id as string,
        ip: request.ip,
        payload: { tool: remediation.tool, sourceType: body.sourceType },
      })
    })
    return reply.code(201).send({ remediation })
  })

  app.post('/ai-agent/remediations/:id/approve', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const remediation = await approveAndExecute(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_agent.remediation_approved',
        objectType: 'ai_remediation',
        objectId: id,
        ip: request.ip,
        payload: { tool: remediation.tool, status: remediation.status },
      })
    })
    return { remediation }
  })

  app.post('/ai-agent/remediations/:id/deny', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const remediation = await denyRemediation(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_agent.remediation_denied',
        objectType: 'ai_remediation',
        objectId: id,
        ip: request.ip,
        payload: { tool: remediation.tool },
      })
    })
    return { remediation }
  })
}
