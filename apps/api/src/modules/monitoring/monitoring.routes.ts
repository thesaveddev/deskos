import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { MONITORING_METRICS, MONITORING_OPERATORS, type MonitoringAction, type MonitoringCondition } from './monitoring.js'
import '../../types.js'

const conditionSchema = z.object({
  op: z.enum(MONITORING_OPERATORS),
  value: z.number().min(0).max(100),
})
const actionSchema = z.object({
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  message: z.string().trim().max(500).optional(),
  createTicket: z.boolean().default(true),
  ticketPriority: z.enum(['p1', 'p2', 'p3', 'p4']).default('p3'),
})
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  metric: z.enum(MONITORING_METRICS),
  condition: conditionSchema,
  action: actionSchema.default({}),
  deviceId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  enabled: z.boolean().default(true),
}).refine((body) => !(body.deviceId && body.groupId), { message: 'Choose a device or group, not both', path: ['deviceId'] })
const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  condition: conditionSchema.optional(),
  action: actionSchema.optional(),
  deviceId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().optional(),
}).refine((body) => !(body.deviceId && body.groupId), { message: 'Choose a device or group, not both', path: ['deviceId'] })

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('monitoring.read')]
  const manage = [authenticate, requireTenant, requirePermission('monitoring.manage')]

  app.get('/monitoring/rules', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { metric?: string; enabled?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const values: unknown[] = []
      const clauses: string[] = []
      if (q.metric && (MONITORING_METRICS as readonly string[]).includes(q.metric)) {
        values.push(q.metric); clauses.push(`r.metric = $${values.length}`)
      }
      if (q.enabled === 'true' || q.enabled === 'false') {
        values.push(q.enabled === 'true'); clauses.push(`r.enabled = $${values.length}`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const rows = await client.query(
        `SELECT r.*, d.name AS device_name, g.name AS group_name,
                (SELECT count(*)::int FROM device_alerts a WHERE a.rule_id = r.id AND a.resolved_at IS NULL) AS open_alerts
           FROM alert_rules r
           LEFT JOIN devices d ON d.id = r.device_id
           LEFT JOIN device_groups g ON g.id = r.group_id
           ${where}
          ORDER BY r.created_at DESC LIMIT 200`,
        values,
      )
      return { rules: rows.rows }
    })
  })

  app.post('/monitoring/rules', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const rule = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.deviceId) {
        const exists = await client.query('SELECT 1 FROM devices WHERE id = $1', [body.deviceId])
        if (!exists.rows[0]) throw AppError.badRequest('Device not found in this tenant', 'device_not_found')
      }
      if (body.groupId) {
        const exists = await client.query('SELECT 1 FROM device_groups WHERE id = $1', [body.groupId])
        if (!exists.rows[0]) throw AppError.badRequest('Device group not found in this tenant', 'group_not_found')
      }
      const result = await client.query(
        `INSERT INTO alert_rules (tenant_id, name, metric, condition, action, device_id, group_id, enabled, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9) RETURNING *`,
        [ctx.tenantId, body.name, body.metric, JSON.stringify(body.condition), JSON.stringify(body.action), body.deviceId ?? null, body.groupId ?? null, body.enabled, request.user!.id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id, action: 'monitoring_rule.created',
        objectType: 'alert_rule', objectId: result.rows[0].id, ip: request.ip,
        payload: { name: body.name, metric: body.metric },
      })
      return result.rows[0]
    })
    return reply.code(201).send({ rule })
  })

  app.get('/monitoring/rules/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT r.*, d.name AS device_name, g.name AS group_name
           FROM alert_rules r LEFT JOIN devices d ON d.id = r.device_id LEFT JOIN device_groups g ON g.id = r.group_id
          WHERE r.id = $1`, [id],
      )
      if (!result.rows[0]) throw AppError.notFound('Monitoring rule not found')
      const alerts = await client.query(
        `SELECT a.*, d.name AS device_name, t.number AS ticket_number
           FROM device_alerts a JOIN devices d ON d.id = a.device_id LEFT JOIN tickets t ON t.id = a.ticket_id
          WHERE a.rule_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [id],
      )
      return { rule: result.rows[0], alerts: alerts.rows }
    })
  })

  app.patch('/monitoring/rules/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM alert_rules WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Monitoring rule not found')
      const deviceId = body.deviceId === undefined ? current.device_id : body.deviceId
      const groupId = body.groupId === undefined ? current.group_id : body.groupId
      if (deviceId && groupId) throw AppError.badRequest('Choose a device or group, not both')
      if (deviceId && !(await client.query('SELECT 1 FROM devices WHERE id = $1', [deviceId])).rows[0]) throw AppError.badRequest('Device not found in this tenant', 'device_not_found')
      if (groupId && !(await client.query('SELECT 1 FROM device_groups WHERE id = $1', [groupId])).rows[0]) throw AppError.badRequest('Device group not found in this tenant', 'group_not_found')
      const result = await client.query(
        `UPDATE alert_rules SET name = $2, condition = $3::jsonb, action = $4::jsonb,
                device_id = $5, group_id = $6, enabled = $7, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, body.name ?? current.name, JSON.stringify(body.condition ?? current.condition), JSON.stringify(body.action ?? current.action), deviceId, groupId, body.enabled ?? current.enabled],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id, action: 'monitoring_rule.updated',
        objectType: 'alert_rule', objectId: id, ip: request.ip,
      })
      return { rule: result.rows[0] }
    })
  })

  app.post('/monitoring/rules/:id/toggle', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query('UPDATE alert_rules SET enabled = $2, updated_at = now() WHERE id = $1 RETURNING id, enabled', [id, enabled])
      if (!result.rows[0]) throw AppError.notFound('Monitoring rule not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id, action: enabled ? 'monitoring_rule.enabled' : 'monitoring_rule.disabled',
        objectType: 'alert_rule', objectId: id, ip: request.ip,
      })
      return { rule: result.rows[0] }
    })
  })

  app.delete('/monitoring/rules/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query('DELETE FROM alert_rules WHERE id = $1 RETURNING id', [id])
      if (!result.rows[0]) throw AppError.notFound('Monitoring rule not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id, action: 'monitoring_rule.deleted',
        objectType: 'alert_rule', objectId: id, ip: request.ip,
      })
      return reply.send({ ok: true })
    })
  })
}
