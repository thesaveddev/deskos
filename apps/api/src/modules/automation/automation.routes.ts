import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import type { AutomationConditions, AutomationAction } from './engine.js'
import '../../types.js'

const TRIGGERS = ['ticket.created', 'ticket.updated', 'device.offline', 'device.low_disk'] as const

const conditionSchema = z.object({
  field: z.string().trim().min(1).max(80),
  op: z.enum(['eq', 'neq', 'contains', 'in']),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
})

const conditionsSchema = z.object({
  all: z.array(conditionSchema).max(20).optional(),
  any: z.array(conditionSchema).max(20).optional(),
})

const actionSchema = z.union([
  z.object({ type: z.literal('set_priority'), priority: z.string().trim().min(1).max(10) }),
  z.object({ type: z.literal('add_tags'), tags: z.array(z.string().trim().min(1).max(60)).min(1).max(20) }),
  z.object({ type: z.literal('assign_team'), team_id: z.string().uuid() }),
  z.object({ type: z.literal('assign_user'), user_id: z.string().uuid() }),
  z.object({
    type: z.literal('notify'),
    role: z.string().trim().min(1).max(60).optional(),
    user_id: z.string().uuid().optional(),
    body: z.string().max(2000).optional(),
  }).refine((a) => a.role || a.user_id, { message: 'notify requires role or user_id' }),
  z.object({ type: z.literal('add_note'), body: z.string().min(1).max(20_000) }),
  z.object({ type: z.literal('webhook'), url: z.string().url() }),
])

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  trigger: z.enum(TRIGGERS),
  conditions: conditionsSchema.default({}),
  actions: z.array(actionSchema).min(1).max(20),
  enabled: z.boolean().default(true),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  conditions: conditionsSchema.optional(),
  actions: z.array(actionSchema).min(1).max(20).optional(),
  enabled: z.boolean().optional(),
})

export async function automationRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('automation.read')]
  const write = [authenticate, requireTenant, requirePermission('automation.manage')]

  app.get('/automations', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, name, trigger, conditions, actions, enabled, last_run_at, run_count, created_at, updated_at
           FROM automations ORDER BY created_at DESC LIMIT 200`,
      )
      return { automations: res.rows }
    })
  })

  app.post('/automations', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const automation = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO automations (tenant_id, name, trigger, conditions, actions, enabled)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         RETURNING id, name, trigger, conditions, actions, enabled, last_run_at, run_count, created_at, updated_at`,
        [ctx.tenantId, body.name, body.trigger, JSON.stringify(body.conditions), JSON.stringify(body.actions), body.enabled],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'automation.created',
        objectType: 'automation',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { name: body.name, trigger: body.trigger },
      })
      return res.rows[0]
    })
    return reply.code(201).send({ automation })
  })

  app.get('/automations/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM automations WHERE id = $1', [id])
      if (!rows[0]) throw AppError.notFound('Automation not found')
      const runs = await client.query(
        `SELECT id, trigger, subject_type, subject_id, status, log, created_at
           FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id],
      )
      return { automation: rows[0], runs: runs.rows }
    })
  })

  app.patch('/automations/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM automations WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Automation not found')

      const name = body.name ?? current.name
      const conditions = body.conditions ?? (current.conditions as AutomationConditions)
      const actions = body.actions ?? (current.actions as AutomationAction[])
      const enabled = body.enabled ?? current.enabled

      const res = await client.query(
        `UPDATE automations SET
           name = $2, conditions = $3::jsonb, actions = $4::jsonb, enabled = $5, updated_at = now()
         WHERE id = $1
         RETURNING id, name, trigger, conditions, actions, enabled, last_run_at, run_count, created_at, updated_at`,
        [id, name, JSON.stringify(conditions), JSON.stringify(actions), enabled],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'automation.updated',
        objectType: 'automation',
        objectId: id,
        ip: request.ip,
      })
      return { automation: res.rows[0] }
    })
  })

  app.post('/automations/:id/toggle', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        'UPDATE automations SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id, enabled, updated_at',
        [id, enabled],
      )
      if (!res.rows[0]) throw AppError.notFound('Automation not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: enabled ? 'automation.enabled' : 'automation.disabled',
        objectType: 'automation',
        objectId: id,
        ip: request.ip,
      })
      return { automation: res.rows[0] }
    })
  })

  app.delete('/automations/:id', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM automations WHERE id = $1 RETURNING id', [id])
      if (!res.rows[0]) throw AppError.notFound('Automation not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'automation.deleted',
        objectType: 'automation',
        objectId: id,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })

  app.get('/automations/:id/runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT id, trigger, subject_type, subject_id, status, log, created_at
           FROM automation_runs WHERE automation_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [id],
      )
      return { runs: res.rows }
    })
  })
}
