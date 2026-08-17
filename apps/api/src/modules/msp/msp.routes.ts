import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { mspConsole, updateBranding } from './msp.js'
import '../../types.js'

const brandingSchema = z.object({
  portalTitle: z.string().trim().min(1).max(60).nullable().optional(),
  logoUrl: z.string().trim().url().max(500).nullable().optional(),
  primaryColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
})

export async function mspRoutes(app: FastifyInstance): Promise<void> {
  // Cross-tenant: no requireTenant here — the handler iterates the caller's own
  // memberships and scopes every stat query to exactly one tenant via withTenant.
  app.get('/msp/console', { preHandler: [authenticate] }, async (request) => {
    return { tenants: await mspConsole(app.db, request.user!.id) }
  })

  app.patch(
    '/tenant/branding',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.manage')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const body = brandingSchema.parse(request.body)
      const branding = await updateBranding(app.db, ctx.tenantId, body)
      await withTenant(app.db, ctx.tenantId, async (client) => {
        await recordAudit(client, ctx.tenantId, {
          actorType: 'user',
          actorId: request.user!.id,
          action: 'tenant.branding_updated',
          objectType: 'tenant',
          objectId: ctx.tenantId,
          ip: request.ip,
          payload: { portalTitle: branding.portalTitle ?? null, hasLogo: Boolean(branding.logoUrl), hasColor: Boolean(branding.primaryColor) },
        })
      })
      return { branding }
    },
  )
}
