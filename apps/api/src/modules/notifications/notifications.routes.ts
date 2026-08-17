import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { withTenant } from '../../db/pool.js'
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
