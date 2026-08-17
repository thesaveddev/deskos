import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { createAiProvider, type AiProvider } from './gateway.js'
import { draftKbArticle, findSimilarTickets, summarizeTicket } from './ai.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable provider for tests; falls back to the configured provider. */
    aiProvider?: AiProvider
  }
}

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const gate = [authenticate, requireTenant, requirePermission('ai.use')]
  const providerFor = () => app.aiProvider ?? createAiProvider(app.config.ai)

  app.post('/ai/tickets/:id/summary', { preHandler: gate }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await summarizeTicket(app.db, ctx.tenantId, id, request.user!.id, providerFor(), app.config.ai.model)
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

  app.post('/ai/tickets/:id/kb-draft', { preHandler: gate }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const article = await draftKbArticle(app.db, ctx.tenantId, id, request.user!.id, providerFor(), app.config.ai.model)
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
