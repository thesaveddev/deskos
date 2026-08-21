import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { DEVICE_TYPES, MONITORING_METRIC_LIMITS, MONITORING_METRICS, MONITORING_OPERATORS, type MonitoringMetric } from './monitoring.js'
import '../../types.js'

const conditionSchema = z.object({
  op: z.enum(MONITORING_OPERATORS),
  value: z.union([z.number().finite().min(0).max(2_000_000_000), z.string().trim().min(1).max(120)]),
  serviceName: z.string().trim().min(1).max(120).optional(),
})

function metricValueIsValid(metric: MonitoringMetric, value: unknown): boolean {
  if (metric === 'service_state') return typeof value === 'string' && value.length > 0
  return typeof value === 'number' && value >= 0 && value <= MONITORING_METRIC_LIMITS[metric].max
}

function metricValidationMessage(metric: MonitoringMetric): string {
  if (metric === 'service_state') return 'Service-state rules require a service name and a state value'
  const limit = MONITORING_METRIC_LIMITS[metric]
  return `${metric} thresholds must be between 0 and ${limit.max} ${limit.unit}`
}
const routingSchema = z.object({
  teamId: z.string().uuid().optional(),
  userIds: z.array(z.string().uuid()).max(50).optional(),
  roles: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
}).default({})
const escalationSchema = z.object({
  levels: z.array(z.object({
    afterMinutes: z.number().int().min(1).max(43_200),
    severity: z.enum(['info', 'warning', 'critical']).optional(),
    routing: routingSchema.optional(),
    createTicket: z.boolean().optional(),
  })).max(5).default([]),
}).default({})
const actionSchema = z.object({
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  message: z.string().trim().max(500).optional(),
  createTicket: z.boolean().default(true),
  ticketPriority: z.enum(['p1', 'p2', 'p3', 'p4']).default('p3'),
  routing: routingSchema,
  escalation: escalationSchema,
})
const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  metric: z.enum(MONITORING_METRICS),
  condition: conditionSchema,
  action: actionSchema.default({}),
  deviceId: z.string().uuid().optional(),
  groupId: z.string().uuid().optional(),
  deviceType: z.enum(DEVICE_TYPES).optional(),
  businessHoursId: z.string().uuid().nullable().optional(),
  maintenanceWindows: z.array(z.object({ start: z.string().datetime(), end: z.string().datetime() })).max(50).default([]),
  minDurationSeconds: z.number().int().min(0).max(86_400).default(0),
  enabled: z.boolean().default(true),
})
  .refine((body) => metricValueIsValid(body.metric, body.condition.value) && (body.metric !== 'service_state' || Boolean(body.condition.serviceName)), { message: 'The threshold is outside the supported range for this metric', path: ['condition', 'value'] })
  .refine((body) => !(body.deviceId && body.groupId), { message: 'Choose a device or group, not both', path: ['deviceId'] })
const availabilityWindowSchema = z.object({
  start: z.string().datetime(),
  end: z.string().datetime(),
  label: z.string().trim().max(120).optional(),
})
const availabilityPolicySchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: z.string().uuid().nullable().optional(),
  deviceType: z.enum(DEVICE_TYPES).nullable().optional(),
  priority: z.number().int().min(-1000).max(1000).default(0),
  offlineThresholdMinutes: z.number().int().min(1).max(43200).default(30),
  gracePeriodMinutes: z.number().int().min(0).max(10080).default(0),
  alertDelayMinutes: z.number().int().min(0).max(10080).default(0),
  ticketDelayMinutes: z.number().int().min(0).max(43200).default(30),
  ticketMode: z.enum(['alert', 'ticket']).default('alert'),
  timezone: z.string().trim().min(1).max(80).default('UTC'),
  businessHoursId: z.string().uuid().nullable().optional(),
  maintenanceWindows: z.array(availabilityWindowSchema).max(50).default([]),
  suppressPowerStates: z.array(z.enum(['ac', 'battery', 'unknown'])).max(3).default(['battery']),
  criticalOverride: z.boolean().default(false),
  recoveryNotifications: z.boolean().default(true),
  enabled: z.boolean().default(true),
})
const availabilityPolicyUpdateSchema = availabilityPolicySchema.partial()

function ensureTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
  } catch {
    throw AppError.badRequest(`Unknown IANA timezone: ${timezone}`, 'invalid_timezone')
  }
}

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  condition: conditionSchema.optional(),
  action: actionSchema.optional(),
  deviceId: z.string().uuid().nullable().optional(),
  groupId: z.string().uuid().nullable().optional(),
  deviceType: z.enum(DEVICE_TYPES).nullable().optional(),
  businessHoursId: z.string().uuid().nullable().optional(),
  maintenanceWindows: z.array(z.object({ start: z.string().datetime(), end: z.string().datetime() })).max(50).optional(),
  minDurationSeconds: z.number().int().min(0).max(86_400).optional(),
  enabled: z.boolean().optional(),
}).refine((body) => !(body.deviceId && body.groupId), { message: 'Choose a device or group, not both', path: ['deviceId'] })

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('monitoring.read')]
  const manage = [authenticate, requireTenant, requirePermission('monitoring.manage')]

  app.get('/monitoring/business-hours', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, (client) => client.query('SELECT id, name, schedule, holidays FROM business_hours ORDER BY name').then((result) => ({ businessHours: result.rows })))
  })

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
        `INSERT INTO alert_rules (tenant_id, name, metric, condition, action, device_id, group_id, device_type, business_hours_id, maintenance_windows, min_duration_seconds, enabled, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11, $12, $13) RETURNING *`,
        [ctx.tenantId, body.name, body.metric, JSON.stringify(body.condition), JSON.stringify(body.action), body.deviceId ?? null, body.groupId ?? null, body.deviceType ?? null, body.businessHoursId ?? null, JSON.stringify(body.maintenanceWindows), body.minDurationSeconds, body.enabled, request.user!.id],
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
      const effectiveCondition = body.condition ?? current.condition
      const metric = current.metric as MonitoringMetric
      if (!metricValueIsValid(metric, effectiveCondition.value)) throw AppError.badRequest(metricValidationMessage(metric), 'invalid_monitoring_threshold')
      if (metric === 'service_state' && !effectiveCondition.serviceName) throw AppError.badRequest(metricValidationMessage(metric), 'invalid_monitoring_threshold')
      if (deviceId && !(await client.query('SELECT 1 FROM devices WHERE id = $1', [deviceId])).rows[0]) throw AppError.badRequest('Device not found in this tenant', 'device_not_found')
      if (groupId && !(await client.query('SELECT 1 FROM device_groups WHERE id = $1', [groupId])).rows[0]) throw AppError.badRequest('Device group not found in this tenant', 'group_not_found')
      const result = await client.query(
        `UPDATE alert_rules SET name = $2, condition = $3::jsonb, action = $4::jsonb,
                device_id = $5, group_id = $6, device_type = $7, business_hours_id = $8,
                maintenance_windows = $9::jsonb, min_duration_seconds = $10, enabled = $11, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, body.name ?? current.name, JSON.stringify(body.condition ?? current.condition), JSON.stringify(body.action ?? current.action), deviceId, groupId, body.deviceType === undefined ? current.device_type : body.deviceType, body.businessHoursId === undefined ? current.business_hours_id : body.businessHoursId, JSON.stringify(body.maintenanceWindows === undefined ? current.maintenance_windows : body.maintenanceWindows), body.minDurationSeconds ?? current.min_duration_seconds, body.enabled ?? current.enabled],
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

  app.get('/monitoring/availability-policies', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(
        `SELECT p.*, g.name AS group_name, b.name AS business_hours_name,
                (SELECT count(*)::int FROM device_alerts a WHERE a.availability_policy_id = p.id AND a.resolved_at IS NULL) AS open_alerts
           FROM device_availability_policies p
           LEFT JOIN device_groups g ON g.id = p.group_id
           LEFT JOIN business_hours b ON b.id = p.business_hours_id
          ORDER BY p.critical_override DESC, p.priority DESC, p.created_at DESC`,
      )
      return { policies: result.rows }
    })
  })

  app.post('/monitoring/availability-policies', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = availabilityPolicySchema.parse(request.body)
    ensureTimezone(body.timezone)
    const policy = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.groupId && !(await client.query('SELECT 1 FROM device_groups WHERE id = $1', [body.groupId])).rows[0]) throw AppError.badRequest('Device group not found in this tenant', 'group_not_found')
      if (body.businessHoursId && !(await client.query('SELECT 1 FROM business_hours WHERE id = $1', [body.businessHoursId])).rows[0]) throw AppError.badRequest('Business-hours schedule not found in this tenant', 'business_hours_not_found')
      const result = await client.query(
        `INSERT INTO device_availability_policies
          (tenant_id, name, group_id, device_type, priority, offline_threshold_minutes, grace_period_minutes,
           alert_delay_minutes, ticket_delay_minutes, ticket_mode, timezone, business_hours_id,
           maintenance_windows, suppress_power_states, critical_override, recovery_notifications, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18)
         RETURNING *`,
        [ctx.tenantId, body.name, body.groupId ?? null, body.deviceType ?? null, body.priority, body.offlineThresholdMinutes, body.gracePeriodMinutes, body.alertDelayMinutes, body.ticketDelayMinutes, body.ticketMode, body.timezone, body.businessHoursId ?? null, JSON.stringify(body.maintenanceWindows), JSON.stringify(body.suppressPowerStates), body.criticalOverride, body.recoveryNotifications, body.enabled, request.user!.id],
      )
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'availability_policy.created', objectType: 'device_availability_policy', objectId: result.rows[0].id, ip: request.ip, payload: { name: body.name } })
      return result.rows[0]
    })
    return reply.code(201).send({ policy })
  })

  app.patch('/monitoring/availability-policies/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = availabilityPolicyUpdateSchema.parse(request.body)
    if (body.timezone) ensureTimezone(body.timezone)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM device_availability_policies WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Availability policy not found')
      const effectiveGroup = body.groupId === undefined ? current.group_id : body.groupId
      const effectiveHours = body.businessHoursId === undefined ? current.business_hours_id : body.businessHoursId
      if (effectiveGroup && !(await client.query('SELECT 1 FROM device_groups WHERE id = $1', [effectiveGroup])).rows[0]) throw AppError.badRequest('Device group not found in this tenant', 'group_not_found')
      if (effectiveHours && !(await client.query('SELECT 1 FROM business_hours WHERE id = $1', [effectiveHours])).rows[0]) throw AppError.badRequest('Business-hours schedule not found in this tenant', 'business_hours_not_found')
      const values: unknown[] = [id]
      const sets: string[] = []
      const fields: Array<[string, keyof typeof body, (value: unknown) => unknown]> = [
        ['name', 'name', (value) => value], ['group_id', 'groupId', (value) => value], ['device_type', 'deviceType', (value) => value],
        ['priority', 'priority', (value) => value], ['offline_threshold_minutes', 'offlineThresholdMinutes', (value) => value],
        ['grace_period_minutes', 'gracePeriodMinutes', (value) => value], ['alert_delay_minutes', 'alertDelayMinutes', (value) => value],
        ['ticket_delay_minutes', 'ticketDelayMinutes', (value) => value], ['ticket_mode', 'ticketMode', (value) => value], ['timezone', 'timezone', (value) => value],
        ['business_hours_id', 'businessHoursId', (value) => value], ['maintenance_windows', 'maintenanceWindows', (value) => JSON.stringify(value)],
        ['suppress_power_states', 'suppressPowerStates', (value) => JSON.stringify(value)], ['critical_override', 'criticalOverride', (value) => value],
        ['recovery_notifications', 'recoveryNotifications', (value) => value], ['enabled', 'enabled', (value) => value],
      ]
      for (const [column, key, transform] of fields) {
        if (body[key] !== undefined) { values.push(transform(body[key])); sets.push(`${column} = $${values.length}`) }
      }
      if (sets.length === 0) throw AppError.badRequest('Nothing to update')
      const result = await client.query(`UPDATE device_availability_policies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, values)
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'availability_policy.updated', objectType: 'device_availability_policy', objectId: id, ip: request.ip })
      return { policy: result.rows[0] }
    })
  })

  app.delete('/monitoring/availability-policies/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query('DELETE FROM device_availability_policies WHERE id = $1 RETURNING id', [id])
      if (!result.rows[0]) throw AppError.notFound('Availability policy not found')
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'availability_policy.deleted', objectType: 'device_availability_policy', objectId: id, ip: request.ip })
      return reply.send({ ok: true })
    })
  })

  app.get('/monitoring/overview', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const devices = await client.query(`SELECT device_type, count(*)::int AS total, count(*) FILTER (WHERE last_seen_at >= now() - interval '10 minutes')::int AS online FROM devices GROUP BY device_type ORDER BY device_type`)
      const alerts = await client.query(`SELECT severity, count(*)::int AS total, count(*) FILTER (WHERE acknowledged_at IS NULL)::int AS unacknowledged FROM device_alerts WHERE resolved_at IS NULL GROUP BY severity ORDER BY severity`)
      const health = await client.query(`SELECT round(avg(cpu_pct)::numeric, 1) AS cpu_pct, round(avg(mem_pct)::numeric, 1) AS mem_pct, round(avg(disk_pct)::numeric, 1) AS disk_pct, round(avg(network_latency_ms)::numeric, 1) AS network_latency_ms, round(avg(battery_pct)::numeric, 1) AS battery_pct FROM (SELECT DISTINCT ON (device_id) * FROM device_metrics ORDER BY device_id, recorded_at DESC) latest`)
      const trend = await client.query(`SELECT date_trunc('day', recorded_at)::date AS day, count(*)::int AS samples, round(avg(cpu_pct)::numeric, 1) AS cpu_pct, round(avg(mem_pct)::numeric, 1) AS mem_pct, round(avg(disk_pct)::numeric, 1) AS disk_pct FROM device_metrics WHERE recorded_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 1`)
      return { devices: devices.rows, alerts: alerts.rows, health: health.rows[0] ?? null, trend: trend.rows }
    })
  })

  app.get('/monitoring/availability', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { from?: string; to?: string }
    const to = q.to ? new Date(q.to) : new Date()
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) throw AppError.badRequest('Invalid availability date range')
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const rows = await client.query(`WITH prior AS (
        SELECT DISTINCT ON (device_id) device_id, status, observed_at
          FROM device_presence_events WHERE tenant_id = $3 AND observed_at < $1 ORDER BY device_id, observed_at DESC
      ), window_events AS (
        SELECT device_id, status, observed_at FROM prior
        UNION ALL
        SELECT device_id, status, observed_at FROM device_presence_events WHERE tenant_id = $3 AND observed_at >= $1 AND observed_at <= $2
      )
      SELECT d.id AS device_id, d.name, e.status, e.observed_at
        FROM devices d LEFT JOIN window_events e ON e.device_id = d.id
       WHERE d.tenant_id = $3 ORDER BY d.id, e.observed_at ASC`, [from, to, ctx.tenantId])
      const grouped = new Map<string, { name: string; events: Array<{ status: string; at: Date }> }>()
      for (const row of rows.rows) {
        if (!grouped.has(row.device_id)) grouped.set(row.device_id, { name: row.name, events: [] })
        if (row.observed_at) grouped.get(row.device_id)!.events.push({ status: row.status, at: new Date(row.observed_at) })
      }
      const totalSeconds = (to.getTime() - from.getTime()) / 1000
      const report = [...grouped.entries()].map(([deviceId, item]) => {
        let status = item.events[0]?.status ?? 'offline'
        let cursor = from.getTime()
        let onlineSeconds = 0
        for (const event of item.events) {
          const eventAt = Math.max(from.getTime(), event.at.getTime())
          if (eventAt > cursor && status === 'online') onlineSeconds += (eventAt - cursor) / 1000
          cursor = Math.max(cursor, eventAt)
          status = event.status
        }
        if (status === 'online') onlineSeconds += Math.max(0, (to.getTime() - cursor) / 1000)
        return { deviceId, name: item.name, onlineSeconds: Math.round(onlineSeconds), totalSeconds: Math.round(totalSeconds), availabilityPct: Number(((onlineSeconds / totalSeconds) * 100).toFixed(2)) }
      })
      return { from: from.toISOString(), to: to.toISOString(), devices: report }
    })
  })
}
