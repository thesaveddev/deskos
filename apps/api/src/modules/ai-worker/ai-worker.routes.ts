import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { createTenantAiProvider } from '../ai/settings.js'
import { createAiProvider } from '../ai/gateway.js'
import { createWorkerRun, listWorkerRuns, getWorkerRun, cancelWorkerRun, approveWorkerStep, denyWorkerStep, getWorkerRunTimeSeries, WORKER_RUN_STATUSES } from './engine.js'
import '../../types.js'

const createSchema = z.object({
  ticketId: z.string().uuid(),
})

const listQuerySchema = z.object({
  status: z.enum(WORKER_RUN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
  ticketId: z.string().uuid().optional(),
})

export async function aiWorkerRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ai_agent.read')]
  const manage = [authenticate, requireTenant, requirePermission('ai_agent.manage')]

  app.get('/ai-worker/metrics', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(`SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
        count(*) FILTER (WHERE status = 'handoff')::int AS escalated,
        COALESCE(avg(estimated_manual_minutes) FILTER (WHERE status IN ('resolved','handoff')), 0)::float8 AS estimated_manual_minutes,
        COALESCE(sum(GREATEST(0, estimated_manual_minutes - COALESCE(actual_minutes, estimated_manual_minutes))) FILTER (WHERE status = 'resolved'), 0)::int AS time_saved_minutes
        FROM ai_worker_runs`)
      const total = Number(rows[0]?.total ?? 0)
      return { metrics: { total, resolved: Number(rows[0]?.resolved ?? 0), escalated: Number(rows[0]?.escalated ?? 0), resolutionRate: total ? Math.round((Number(rows[0]?.resolved ?? 0) / total) * 1000) / 10 : 0, estimatedManualMinutes: Number(rows[0]?.estimated_manual_minutes ?? 0), timeSavedMinutes: Number(rows[0]?.time_saved_minutes ?? 0) } }
    })
  })

  app.get('/ai-worker/runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = listQuerySchema.parse(request.query)
    return listWorkerRuns(app.db, ctx.tenantId, { status: query.status, limit: query.limit, cursor: query.cursor, ticketId: query.ticketId })
  })

  app.get('/ai-worker/runs/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { run: await getWorkerRun(app.db, ctx.tenantId, id) }
  })

  app.get('/ai-worker/timeseries', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const q = (request.query ?? {}) as { days?: string }
    const days = Math.min(Math.max(1, Number(q.days) || 30), 365)
    return { timeseries: await getWorkerRunTimeSeries(app.db, ctx.tenantId, days) }
  })

  app.post('/ai-worker/runs', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const tenantAi = await createTenantAiProvider(app.db, app.config, ctx.tenantId, app.aiProvider, true).catch((error) => {
      if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'ai_unavailable') {
        return { provider: createAiProvider(app.config.ai), model: app.config.ai.model }
      }
      throw error
    })
    const run = await createWorkerRun(app.db, ctx.tenantId, body.ticketId, request.user!.id, {
      pool: app.db,
      provider: tenantAi.provider,
      model: tenantAi.model,
      webhookKey: app.config.emailKey,
      config: app.config,
    }, { triggerType: 'manual' })
    if (!run) throw new Error('worker run not created')
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_worker.run_created',
        objectType: 'ai_worker_run',
        objectId: run.id,
        ip: request.ip,
        payload: { ticketId: body.ticketId },
      })
    })
    return reply.code(201).send({ run })
  })

  app.post('/ai-worker/runs/:id/approve', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { run } = await approveWorkerStep(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_worker.step_approved',
        objectType: 'ai_worker_run',
        objectId: id,
        ip: request.ip,
      })
    })
    return { run }
  })

  app.post('/ai-worker/runs/:id/deny', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { run } = await denyWorkerStep(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_worker.step_denied',
        objectType: 'ai_worker_run',
        objectId: id,
        ip: request.ip,
      })
    })
    return { run }
  })

  app.post('/ai-worker/runs/:id/cancel', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const run = await cancelWorkerRun(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai_worker.run_cancelled',
        objectType: 'ai_worker_run',
        objectId: id,
        ip: request.ip,
      })
    })
    return { run }
  })
}