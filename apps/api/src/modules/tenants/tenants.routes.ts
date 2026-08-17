import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticate } from '../../middleware/authenticate.js'
import '../../types.js'

const tenantPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens')
    .optional(),
  region: z.string().trim().min(1).max(60).optional(),
})

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/tenant',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query(
        'SELECT id, name, slug, region, settings, created_at FROM tenants WHERE id = $1',
        [ctx.tenantId],
      )
      const tenant = rows[0]
      return {
        tenant,
        membership: { orgRole: ctx.orgRole, membershipId: ctx.membershipId },
      }
    },
  )

  app.patch(
    '/tenant',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.manage')] },
    async (request, reply) => {
      const body = tenantPatchSchema.parse(request.body)
      const ctx = request.tenantCtx!

      if (body.slug) {
        const { rows } = await app.db.query('SELECT id FROM tenants WHERE slug = $1', [body.slug])
        if (rows.length > 0 && rows[0].id !== ctx.tenantId) {
          throw new AppError(409, 'slug_taken', 'That slug is already in use.')
        }
      }

      const sets: string[] = []
      const values: unknown[] = []
      let i = 1
      for (const key of ['name', 'slug', 'region'] as const) {
        if (body[key] !== undefined) {
          sets.push(`${key} = $${i++}`)
          values.push(body[key])
        }
      }
      if (sets.length === 0) return { ok: true }

      values.push(ctx.tenantId)
      const { rows } = await app.db.query(
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, slug, region, settings, created_at`,
        values,
      )
      reply.code(200)
      return { ok: true, tenant: rows[0] }
    },
  )
}
