import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { NOTIFICATION_CHANNELS, NOTIFICATION_KINDS } from '../../core/notify.js'
import '../../types.js'

const upsertSchema = z.object({
  enabled: z.boolean().optional(),
  channels: z.array(z.enum(NOTIFICATION_CHANNELS)).optional(),
})

const kindSchema = z.string().trim().min(1).max(80)

export async function notificationPreferenceRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.get('/notification-preferences', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT kind, enabled, channels FROM notification_preferences WHERE user_id = $1`,
        [userId],
      )
      const byKind = new Map<string, { enabled: boolean; channels: string[] }>()
      for (const row of rows) {
        byKind.set(row.kind, { enabled: row.enabled, channels: row.channels ?? ['in_app'] })
      }
      const preferences = NOTIFICATION_KINDS.map((kind) => {
        const pref = byKind.get(kind)
        return { kind, enabled: pref?.enabled ?? true, channels: pref?.channels ?? ['in_app'] }
      })
      return { preferences }
    })
  })

  app.put('/notification-preferences/:kind', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    const body = upsertSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO notification_preferences (tenant_id, user_id, kind, enabled, channels)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (tenant_id, user_id, kind)
         DO UPDATE SET enabled = EXCLUDED.enabled, channels = EXCLUDED.channels, updated_at = now()
         RETURNING kind, enabled, channels, updated_at`,
        [
          ctx.tenantId,
          userId,
          kind,
          body.enabled ?? true,
          JSON.stringify(body.channels ?? ['in_app']),
        ],
      )
      return { preference: res.rows[0] }
    })
  })

  app.delete('/notification-preferences/:kind', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const userId = request.user!.id
    const kind = kindSchema.parse((request.params as { kind: string }).kind)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await client.query(
        'DELETE FROM notification_preferences WHERE user_id = $1 AND kind = $2',
        [userId, kind],
      )
      return reply.code(200).send({ ok: true, kind })
    })
  })
}
