import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import {
  listAiActivity, getActivitySummary,
  listToolPermissions, updateToolPermission, ensureToolPermissions,
  getCostSummary,
  createUsageAlert, listUsageAlerts, deleteUsageAlert, checkUsageAlerts,
} from './governance.js'
import '../../types.js'

const toolPermissionSchema = z.object({
  enabled: z.boolean().optional(),
  requires_approval: z.boolean().optional(),
  max_uses_per_hour: z.number().int().min(1).max(10000).optional(),
  allowed_roles: z.array(z.string()).optional(),
})

const usageAlertSchema = z.object({
  alert_type: z.enum(['request_threshold', 'token_threshold', 'cost_threshold', 'failure_rate']),
  threshold_value: z.number().min(0),
})

export async function governanceRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ai_agent.read')]
  const manage = [authenticate, requireTenant, requirePermission('ai_agent.manage')]

  // ---- Activity log ----

  app.get('/ai-governance/activity', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = (request.query ?? {}) as { action?: string; actor_type?: string; tool_name?: string; limit?: string; cursor?: string; days?: string }
    return listAiActivity(app.db, ctx.tenantId, {
      action: query.action,
      actor_type: query.actor_type,
      tool_name: query.tool_name,
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor,
      days: query.days ? Number(query.days) : undefined,
    })
  })

  app.get('/ai-governance/summary', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = (request.query ?? {}) as { days?: string }
    const days = query.days ? Math.min(Math.max(1, Number(query.days)), 365) : 30
    return { summary: await getActivitySummary(app.db, ctx.tenantId, days) }
  })

  // ---- Tool permissions ----

  app.get('/ai-governance/tools', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    await ensureToolPermissions(app.db, ctx.tenantId)
    const permissions = await listToolPermissions(app.db, ctx.tenantId)
    return { permissions }
  })

  app.patch('/ai-governance/tools/:toolName', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { toolName } = request.params as { toolName: string }
    const body = toolPermissionSchema.parse(request.body)
    const permission = await updateToolPermission(app.db, ctx.tenantId, toolName, body)
    return { permission }
  })

  // ---- Cost tracking ----

  app.get('/ai-governance/costs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = (request.query ?? {}) as { days?: string }
    const days = query.days ? Math.min(Math.max(1, Number(query.days)), 365) : 30
    return { costs: await getCostSummary(app.db, ctx.tenantId, days) }
  })

  // ---- Usage alerts ----

  app.get('/ai-governance/alerts', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const alerts = await listUsageAlerts(app.db, ctx.tenantId)
    return { alerts }
  })

  app.post('/ai-governance/alerts', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = usageAlertSchema.parse(request.body)
    const alert = await createUsageAlert(app.db, ctx.tenantId, body.alert_type, body.threshold_value)
    return reply.code(201).send({ alert })
  })

  app.delete('/ai-governance/alerts/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deleteUsageAlert(app.db, ctx.tenantId, id)
    return reply.code(204).send()
  })

  app.post('/ai-governance/alerts/check', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const fired = await checkUsageAlerts(app.db, ctx.tenantId)
    return { fired }
  })
}
