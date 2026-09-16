import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const updateOnboardingSchema = z.object({
  completed: z.boolean(),
  step: z.string().max(100).optional(),
})

export async function onboardingRoutes(app: FastifyInstance): Promise<void> {
  // Get onboarding status for the current tenant
  app.get('/onboarding', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const tenantId = request.tenantCtx!.tenantId
    const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])
    const settings = rows[0]?.settings ?? {}
    const onboarding = settings.onboarding ?? { completed: false, step: null, completed_at: null }
    return {
      completed: Boolean(onboarding.completed),
      step: onboarding.step ?? null,
      completedAt: onboarding.completed_at ?? null,
    }
  })

  // Update onboarding status
  app.patch('/onboarding', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const tenantId = request.tenantCtx!.tenantId
    const body = updateOnboardingSchema.parse(request.body)
    const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])
    const settings = rows[0]?.settings ?? {}
    const onboarding = {
      completed: body.completed,
      step: body.step ?? (body.completed ? 'complete' : null),
      completed_at: body.completed ? new Date().toISOString() : null,
    }
    await app.db.query('UPDATE tenants SET settings = $1 WHERE id = $2', [
      { ...settings, onboarding },
      tenantId,
    ])
    return { ok: true, onboarding }
  })
}
