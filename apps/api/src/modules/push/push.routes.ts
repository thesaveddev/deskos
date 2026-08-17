import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { deleteSubscription, listSubscriptions, saveSubscription, sendPushToUser, type PushHttp } from './push.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable HTTP client for push delivery; defaults to global fetch. */
    pushHttp?: PushHttp
  }
}

const subscriptionSchema = z.object({
  endpoint: z.string().trim().min(1).max(1000),
  p256dh: z.string().trim().min(1).max(200),
  auth: z.string().trim().min(1).max(200),
  userAgent: z.string().trim().max(300).optional(),
})

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]
  const httpFor = (): PushHttp =>
    app.pushHttp ??
    (async (endpoint, init) => {
      const res = await fetch(endpoint, { method: init.method, headers: init.headers, body: init.body as unknown as BodyInit })
      return { status: res.status }
    })

  // Public: the application-server key browsers need before subscribing.
  app.get('/push/vapid-public-key', async (_request, reply) => {
    if (!app.config.push.enabled) {
      throw new AppError(503, 'push_disabled', 'Web Push is not configured (set DESKOS_VAPID_PUBLIC_KEY, DESKOS_VAPID_PRIVATE_KEY, DESKOS_VAPID_SUBJECT)')
    }
    return { publicKey: app.config.push.publicKey }
  })

  app.get('/push/subscriptions', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    return { subscriptions: await listSubscriptions(app.db, ctx.tenantId, request.user!.id) }
  })

  app.post('/push/subscriptions', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = subscriptionSchema.parse(request.body)
    const subscription = await saveSubscription(app.db, ctx.tenantId, request.user!.id, body, app.config.emailKey)
    return reply.code(201).send({ subscription })
  })

  app.delete('/push/subscriptions/:id', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const deleted = await deleteSubscription(app.db, ctx.tenantId, request.user!.id, id)
    if (!deleted) throw AppError.notFound('Push subscription not found')
    return reply.code(200).send({ ok: true })
  })

  // Fire-and-forget test delivery to the caller's own subscriptions.
  app.post('/push/subscriptions/test', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!app.config.push.enabled) {
      throw new AppError(503, 'push_disabled', 'Web Push is not configured (set DESKOS_VAPID_*)')
    }
    const result = await sendPushToUser(app.db, app.config.push, ctx.tenantId, request.user!.id, 'test', 'Push notifications are working.', app.config.emailKey, httpFor())
    return reply.code(result.delivered > 0 ? 200 : 202).send(result)
  })

  // Convenience: count the caller's subscription rows (used by the web UI state).
  app.get('/push/status', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const subs = await withTenant(app.db, ctx.tenantId, (client) =>
      client.query('SELECT COUNT(*)::int AS count FROM push_subscriptions WHERE user_id = $1', [request.user!.id]).then((r) => r.rows[0].count),
    )
    return { enabled: app.config.push.enabled, subscriptions: subs }
  })
}