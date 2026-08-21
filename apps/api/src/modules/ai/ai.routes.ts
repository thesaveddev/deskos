import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import type { AiProvider } from './gateway.js'
import { createTenantAiProvider, getAiSettingsView, getAiUsage, aiProcessingNotice, testTenantAiProvider, updateAiSettings, type AiSettingsPatch } from './settings.js'
import { draftKbArticle, findSimilarTickets, summarizeTicket } from './ai.js'
import { dispatchTicketTriage, getTriageState, stopTicketTriage } from './triage.js'
import '../../types.js'

const aiSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  providerMode: z.enum(['managed', 'byok']).optional(),
  provider: z.enum(['openai_compatible', 'azure_openai', 'ollama', 'vllm']).optional(),
  baseUrl: z.string().trim().max(500).optional(),
  model: z.string().trim().max(160).optional(),
  modelAllowlist: z.array(z.string().trim().min(1).max(160)).max(20).optional(),
  apiKey: z.string().max(500).optional(),
  clearApiKey: z.boolean().optional(),
  retentionDays: z.number().int().min(7).max(3650).optional(),
  redactContent: z.boolean().optional(),
  monthlyRequestLimit: z.number().int().min(-1).max(10_000_000).nullable().optional(),
  monthlyTokenLimit: z.number().int().min(-1).max(1_000_000_000).nullable().optional(),
}).strict()

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable provider for tests; falls back to the configured provider. */
    aiProvider?: AiProvider
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const gate = [authenticate, requireTenant, requirePermission('ai.use')]
  const settingsGate = [authenticate, requireTenant, requirePermission('settings.manage')]
  const providerFor = async (tenantId: string) => createTenantAiProvider(app.db, app.config, tenantId, app.aiProvider)

  app.get('/ai/settings', { preHandler: settingsGate }, async (request) => {
    const ctx = request.tenantCtx!
    return { settings: await getAiSettingsView(app.db, app.config, ctx.tenantId, Boolean(app.aiProvider)), notice: aiProcessingNotice() }
  })

  app.patch('/ai/settings', { preHandler: settingsGate }, async (request) => {
    const ctx = request.tenantCtx!
    await updateAiSettings(app.db, app.config, ctx.tenantId, request.user!.id, aiSettingsPatchSchema.parse(request.body ?? {}) as AiSettingsPatch)
    return { settings: await getAiSettingsView(app.db, app.config, ctx.tenantId, Boolean(app.aiProvider)) }
  })

  app.post('/ai/settings/test', { preHandler: settingsGate }, async (request) => {
    const ctx = request.tenantCtx!
    return await testTenantAiProvider(app.db, app.config, ctx.tenantId, app.aiProvider)
  })

  app.get('/ai/usage', { preHandler: settingsGate }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { days?: string }
    const days = Math.max(1, Math.min(365, Number(query.days ?? 30) || 30))
    return { usage: await getAiUsage(app.db, ctx.tenantId, days) }
  })

  app.post('/ai/tickets/:id/summary', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const tenantAi = await providerFor(ctx.tenantId)
    const result = await summarizeTicket(app.db, ctx.tenantId, id, request.user!.id, tenantAi.provider, tenantAi.model)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai.summary_generated',
        objectType: 'ticket',
        objectId: id,
        ip: request.ip,
        payload: { threadId: result.id },
      })
    })
    return result
  })

  app.get('/ai/tickets/:id/similar', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { similar: await findSimilarTickets(app.db, ctx.tenantId, id) }
  })

  app.get('/ai/tickets/:id/triage', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { triage: await getTriageState(app.db, ctx.tenantId, id) }
  })

  app.post('/ai/tickets/:id/triage/retry', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    void dispatchTicketTriage(ctx.tenantId, id, 'retry')
    return { ok: true, status: 'queued' }
  })

  app.post('/ai/tickets/:id/triage/stop', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { triage: await stopTicketTriage(app.db, ctx.tenantId, id, `Stopped by ${request.user!.name}.`) }
  })

  app.post('/ai/tickets/:id/kb-draft', { preHandler: gate }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const tenantAi = await providerFor(ctx.tenantId)
    const article = await draftKbArticle(app.db, ctx.tenantId, id, request.user!.id, tenantAi.provider, tenantAi.model)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ai.kb_draft_created',
        objectType: 'kb_article',
        objectId: article.id as string,
        ip: request.ip,
        payload: { ticketId: id },
      })
    })
    return reply.code(201).send({ article })
  })
}
