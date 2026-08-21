import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { fleetDex, getDeviceDex, recomputeDevice } from './dex.js'
import '../../types.js'

const deviceType = z.enum(['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'])
const weightSchema = z.object({ performance: z.number().min(0).max(1), availability: z.number().min(0).max(1), security: z.number().min(0).max(1), user_impact: z.number().min(0).max(1) })
const policySchema = z.object({ name: z.string().trim().min(2).max(120), deviceType: deviceType.nullable().optional(), weights: weightSchema, enabled: z.boolean().optional() })

export async function dexRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('rmm.read')]
  const manage = [authenticate, requireTenant, requirePermission('rmm.manage')]

  app.get('/devices/:id/dex', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return getDeviceDex(app.db, ctx.tenantId, id)
  })

  app.get('/dex/fleet', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return fleetDex(app.db, ctx.tenantId)
  })

  app.get('/dex/compare', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { dimension?: string }
    const dimension = ['department', 'team', 'location', 'device_type'].includes(query.dimension ?? '') ? query.dimension : 'department'
    const expression = dimension === 'device_type' ? "COALESCE(NULLIF(d.device_type, ''), 'Unclassified')" : dimension === 'location' ? "COALESCE(NULLIF(da.location, ''), 'Unassigned')" : dimension === 'team' ? "COALESCE(t.name, 'Unassigned')" : "COALESCE(NULLIF(da.department, ''), 'Unassigned')"
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${expression} AS segment, count(*)::int AS devices,
                round(avg(s.score))::int AS score,
                round(avg((s.components->>'performance')::numeric))::int AS performance,
                round(avg((s.components->>'availability')::numeric))::int AS availability,
                round(avg((s.components->>'security')::numeric))::int AS security,
                round(avg((s.components->>'user_impact')::numeric))::int AS user_impact
           FROM device_dex_scores s
           JOIN devices d ON d.id = s.device_id
           LEFT JOIN device_assignments da ON da.device_id = d.id AND da.ended_at IS NULL
           LEFT JOIN teams t ON t.id = da.team_id
          GROUP BY 1 ORDER BY score ASC, segment ASC`,
      )
      return { dimension, comparisons: result.rows }
    })
  })

  app.get('/dex/trends', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { days?: string }
    const days = Math.min(365, Math.max(7, Number(query.days ?? 90) || 90))
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT date_trunc('day', computed_at)::date AS day, round(avg(score))::int AS score,
                round(avg((components->>'performance')::numeric))::int AS performance,
                round(avg((components->>'availability')::numeric))::int AS availability,
                round(avg((components->>'security')::numeric))::int AS security,
                round(avg((components->>'user_impact')::numeric))::int AS user_impact,
                count(*)::int AS samples
           FROM device_dex_score_history
          WHERE computed_at >= now() - make_interval(days => $1)
          GROUP BY 1 ORDER BY 1`,
        [days],
      )
      return { days, trends: result.rows }
    })
  })

  app.get('/dex/policies', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, (client) => client.query(
      `SELECT id, name, device_type, weights, enabled, created_by, created_at, updated_at
         FROM dex_scoring_policies ORDER BY device_type NULLS LAST, name`,
    ).then((result) => ({ policies: result.rows })))
  })

  app.post('/dex/policies', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = policySchema.parse(request.body)
    const sum = Object.values(body.weights).reduce((a, b) => a + b, 0)
    if (sum <= 0) throw AppError.badRequest('At least one DEX component weight must be greater than zero', 'invalid_weights')
    const result = await withTenant(app.db, ctx.tenantId, (client) => client.query(
      `INSERT INTO dex_scoring_policies (tenant_id, name, device_type, weights, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6) RETURNING *`,
      [ctx.tenantId, body.name, body.deviceType ?? null, JSON.stringify(body.weights), body.enabled ?? true, request.user!.id],
    ))
    return reply.code(201).send({ policy: result.rows[0] })
  })

  app.patch('/dex/policies/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = policySchema.partial().parse(request.body)
    const current = await withTenant(app.db, ctx.tenantId, (client) => client.query('SELECT * FROM dex_scoring_policies WHERE id = $1', [id]))
    if (!current.rows[0]) throw AppError.notFound('DEX scoring policy not found')
    const values: unknown[] = []
    const sets: string[] = []
    if (body.name !== undefined) { values.push(body.name); sets.push(`name = $${values.length}`) }
    if (body.deviceType !== undefined) { values.push(body.deviceType); sets.push(`device_type = $${values.length}`) }
    if (body.weights !== undefined) { values.push(JSON.stringify(body.weights)); sets.push(`weights = $${values.length}::jsonb`) }
    if (body.enabled !== undefined) { values.push(body.enabled); sets.push(`enabled = $${values.length}`) }
    if (!sets.length) throw AppError.badRequest('Nothing to update')
    values.push(id)
    return withTenant(app.db, ctx.tenantId, (client) => client.query(`UPDATE dex_scoring_policies SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`, values).then((result) => ({ policy: result.rows[0] })))
  })

  app.delete('/dex/policies/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await withTenant(app.db, ctx.tenantId, (client) => client.query('DELETE FROM dex_scoring_policies WHERE id = $1 RETURNING id', [id]))
    if (!result.rows[0]) throw AppError.notFound('DEX scoring policy not found')
    return { ok: true }
  })

  app.put('/devices/:id/dex/assignment', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = z.object({
      userId: z.string().uuid().nullable().optional(),
      assignmentStatus: z.enum(['assigned', 'shared', 'temporary']).default('assigned'),
      department: z.string().trim().max(160).optional(),
      teamId: z.string().uuid().nullable().optional(),
      location: z.string().trim().max(160).optional(),
      expectedReturnAt: z.string().datetime({ offset: true }).nullable().optional(),
      reason: z.string().trim().max(500).optional(),
      notes: z.string().trim().max(5_000).optional(),
    }).parse(request.body)
    if (body.assignmentStatus === 'shared' && body.userId) throw AppError.badRequest('A shared device cannot have a primary user', 'shared_assignment_user')
    if (body.assignmentStatus !== 'shared' && !body.userId) throw AppError.badRequest('Select a staff member or choose Shared device', 'assignment_user_required')
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const device = (await client.query('SELECT id FROM devices WHERE id = $1', [id])).rows[0]
      if (!device) throw AppError.notFound('Device not found')
      if (body.userId && !(await client.query("SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'", [ctx.tenantId, body.userId])).rows[0]) {
        throw AppError.badRequest('The selected staff member is not active in this organization', 'assignment_user_invalid')
      }
      await client.query(`UPDATE device_assignments SET ended_at = now(), returned_at = now(), assignment_status = 'returned', audit_event = 'device.assignment.replaced' WHERE device_id = $1 AND ended_at IS NULL`, [id])
      const result = await client.query(
        `INSERT INTO device_assignments
           (tenant_id, device_id, user_id, assigned_by, department, team_id, location, assignment_status, expected_return_at, reason, notes, audit_event)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'device.assignment.created') RETURNING *`,
        [ctx.tenantId, id, body.userId ?? null, request.user!.id, body.department ?? '', body.teamId ?? null,
          body.location ?? '', body.assignmentStatus, body.expectedReturnAt ?? null, body.reason ?? '', body.notes ?? ''],
      )
      return { assignment: result.rows[0] }
    })
  })

  app.post('/devices/:id/dex/survey', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().max(2_000).optional() }).parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const device = (await client.query('SELECT id FROM devices WHERE id = $1', [id])).rows[0]
      if (!device) throw AppError.notFound('Device not found')
      await client.query('INSERT INTO dex_user_surveys (tenant_id, device_id, user_id, rating, comment) VALUES ($1, $2, $3, $4, $5)', [ctx.tenantId, id, request.user!.id, body.rating, body.comment ?? ''])
      return { ok: true }
    })
  })

  app.post('/devices/:id/dex/recompute', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return recomputeDevice(app.db, ctx.tenantId, id)
  })
}
