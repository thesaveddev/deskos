import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import {
  approveGrant,
  checkinGrant,
  checkoutGrant,
  createGrant,
  denyGrant,
  GRANTABLE_PERMISSIONS,
  GRANT_SCOPES,
  GRANT_STATUSES,
  listGrants,
  revokeGrant,
} from './grants.js'
import '../../types.js'

const createSchema = z.object({
  granteeId: z.string().uuid().optional(),
  permission: z.enum(GRANTABLE_PERMISSIONS),
  scopeType: z.enum(GRANT_SCOPES),
  scopeId: z.string().uuid().optional(),
  reason: z.string().trim().min(1).max(500),
  expiresAt: z.string().min(1),
})

export async function grantRoutes(app: FastifyInstance): Promise<void> {
  const requestGuard = [authenticate, requireTenant, requirePermission('grant.request')]
  const readGuard = [authenticate, requireTenant, requirePermission('grant.read')]
  const approveGuard = [authenticate, requireTenant, requirePermission('grant.approve')]

  app.post('/grants', { preHandler: requestGuard }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const grant = await createGrant(app.db, ctx.tenantId, body, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'grant.requested',
        objectType: 'grant',
        objectId: grant.id,
        ip: request.ip,
        payload: { permission: body.permission, scopeType: body.scopeType, scopeId: body.scopeId ?? null, granteeId: body.granteeId ?? null },
      })
    })
    return reply.code(201).send({ grant })
  })

  app.get('/grants', { preHandler: readGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { status, mine } = request.query as Record<string, string | undefined>
    const grants = await listGrants(app.db, ctx.tenantId, {
      status: status as (typeof GRANT_STATUSES)[number] | undefined,
      mine: mine === '1' ? request.user!.id : undefined,
    })
    return { grants }
  })

  app.post('/grants/:id/approve', { preHandler: approveGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const grant = await approveGrant(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'grant.approved',
        objectType: 'grant',
        objectId: id,
        ip: request.ip,
        payload: { permission: grant.permission, granteeId: grant.subject_id },
      })
    })
    return { grant }
  })

  app.post('/grants/:id/deny', { preHandler: approveGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const grant = await denyGrant(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'grant.denied',
        objectType: 'grant',
        objectId: id,
        ip: request.ip,
        payload: { permission: grant.permission, granteeId: grant.subject_id },
      })
    })
    return { grant }
  })

  app.post('/grants/:id/revoke', { preHandler: approveGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const grant = await revokeGrant(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'grant.revoked',
        objectType: 'grant',
        objectId: id,
        ip: request.ip,
        payload: { permission: grant.permission, granteeId: grant.subject_id },
      })
    })
    return { grant }
  })

  app.post('/grants/:id/checkout', { preHandler: requestGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const grant = await checkoutGrant(app.db, ctx.tenantId, id, request.user!.id)
    return { grant }
  })

  app.post('/grants/:id/checkin', { preHandler: requestGuard }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const grant = await checkinGrant(app.db, ctx.tenantId, id, request.user!.id)
    return { grant }
  })
}
