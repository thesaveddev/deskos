import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../../db/pool.js'
import { subscribeNotifications } from '../../core/notify.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const readSchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
  all: z.boolean().optional(),
})

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/notifications/stream',
    { preHandler: [authenticate, requireTenant, requirePermission('notification.read')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const userId = request.user!.id
      const raw = reply.raw
      let closed = false
      let heartbeat: NodeJS.Timeout | null = null
      let unsubscribe: () => void = () => undefined

      reply.hijack()
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })

      const write = (event: string, payload: unknown) => {
        if (closed || raw.writableEnded) return
        raw.write(`event: ${event}\\ndata: ${JSON.stringify(payload)}\\n\\n`)
      }
      const close = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        unsubscribe()
      }
      unsubscribe = subscribeNotifications(ctx.tenantId, userId, (notification) => {
        write('notification', {
          id: notification.id,
          kind: notification.kind,
          subject_type: notification.subjectType,
          subject_id: notification.subjectId,
          body: notification.body,
          read_at: null,
          created_at: notification.createdAt,
        })
      })

      request.raw.once('close', close)
      heartbeat = setInterval(() => {
        if (closed || raw.writableEnded) return
        raw.write(': heartbeat\\n\\n')
      }, 25_000)
      heartbeat.unref()
      write('ready', { connectedAt: new Date().toISOString() })
      return reply
    },
  )

  app.get(
    '/notifications',
    { preHandler: [authenticate, requireTenant, requirePermission('notification.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const userId = request.user!.id
      const notifications = await withTenant(app.db, ctx.tenantId, (client) =>
        client
          .query(
            `SELECT id, kind, subject_type, subject_id, body, read_at, created_at
               FROM notifications
              WHERE user_id = $1
              ORDER BY created_at DESC
              LIMIT 100`,
            [userId],
          )
          .then((r) => r.rows),
      )
      return { notifications }
    },
  )

  app.post(
    '/notifications/read',
    { preHandler: [authenticate, requireTenant, requirePermission('notification.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const userId = request.user!.id
      const body = readSchema.parse(request.body ?? {})

      const updated = await withTenant(app.db, ctx.tenantId, async (client) => {
        if (body.all) {
          const r = await client.query(
            'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
            [userId],
          )
          return r.rowCount ?? 0
        }
        if (body.ids && body.ids.length > 0) {
          const r = await client.query(
            'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL',
            [userId, body.ids],
          )
          return r.rowCount ?? 0
        }
        return 0
      })
      return { updated }
    },
  )
}
