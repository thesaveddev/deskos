import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import {
  createEndpoint,
  defaultWebhookHttp,
  deleteEndpoint,
  listDeliveries,
  listEndpoints,
  testEndpoint,
  updateEndpoint,
  WEBHOOK_CHANNELS,
  type WebhookHttp,
} from './webhooks.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable outbound HTTP for tests; defaults to global fetch. */
    webhookHttp?: WebhookHttp
  }
}

const endpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().url().max(1000),
  secret: z.string().min(1).max(2000).optional(),
  channel: z.enum(WEBHOOK_CHANNELS).optional(),
  events: z.array(z.string().trim().min(1).max(100)).min(1).max(50).optional(),
  enabled: z.boolean().optional(),
})

const updateSchema = endpointSchema.partial()

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('integration.read')]
  const manage = [authenticate, requireTenant, requirePermission('integration.manage')]
  const key = () => app.config.emailKey
  const http = () => app.webhookHttp ?? defaultWebhookHttp

  app.get('/webhooks', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { endpoints: await listEndpoints(app.db, ctx.tenantId) }
  })

  app.post('/webhooks', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = endpointSchema.parse(request.body)
    const endpoint = await createEndpoint(app.db, ctx.tenantId, body, key(), request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'webhook.endpoint_created',
        objectType: 'webhook_endpoint',
        objectId: endpoint.id as string,
        ip: request.ip,
        payload: { name: body.name, channel: body.channel ?? 'generic' },
      })
    })
    return reply.code(201).send({ endpoint })
  })

  app.patch('/webhooks/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    const endpoint = await updateEndpoint(app.db, ctx.tenantId, id, body, key())
    return { endpoint }
  })

  app.delete('/webhooks/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deleteEndpoint(app.db, ctx.tenantId, id)
    return { ok: true }
  })

  app.post('/webhooks/:id/test', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await testEndpoint(app.db, ctx.tenantId, id, key(), http())
    if (result.status === 'failed') throw new AppError(502, 'webhook_delivery_failed', result.lastError)
    return result
  })

  app.get('/webhooks/:id/deliveries', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { deliveries: await listDeliveries(app.db, ctx.tenantId, id) }
  })
}
