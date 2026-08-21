import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import { createAutomationTicket, firstOwner } from '../devices/alerts.js'

export const DEVICE_TYPES = ['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'] as const
export type DeviceType = (typeof DEVICE_TYPES)[number]

export const MONITORING_METRICS = [
  'cpu_pct', 'mem_pct', 'disk_pct', 'battery_pct', 'battery_health_pct',
  'network_latency_ms', 'uptime_seconds', 'process_count', 'heartbeat_age_seconds', 'service_state',
] as const
export type MonitoringMetric = (typeof MONITORING_METRICS)[number]
export type MonitoringScalar = number | string

export const MONITORING_METRIC_LIMITS: Record<Exclude<MonitoringMetric, 'service_state'>, { max: number; unit: string }> = {
  cpu_pct: { max: 100, unit: '%' },
  mem_pct: { max: 100, unit: '%' },
  disk_pct: { max: 100, unit: '%' },
  battery_pct: { max: 100, unit: '%' },
  battery_health_pct: { max: 100, unit: '%' },
  network_latency_ms: { max: 60_000, unit: 'ms' },
  uptime_seconds: { max: 2_000_000_000, unit: 'seconds' },
  process_count: { max: 1_000_000, unit: 'processes' },
  heartbeat_age_seconds: { max: 2_000_000_000, unit: 'seconds' },
}
export const MONITORING_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq', 'contains'] as const
export type MonitoringOperator = (typeof MONITORING_OPERATORS)[number]

export interface MonitoringCondition {
  op: MonitoringOperator
  value: MonitoringScalar
  serviceName?: string
}

export interface MonitoringRouting {
  teamId?: string
  userIds?: string[]
  roles?: string[]
}

export interface MonitoringEscalationLevel {
  afterMinutes: number
  severity?: 'info' | 'warning' | 'critical'
  routing?: MonitoringRouting
  createTicket?: boolean
}

export interface MonitoringAction {
  severity?: 'info' | 'warning' | 'critical'
  message?: string
  createTicket?: boolean
  ticketPriority?: 'p1' | 'p2' | 'p3' | 'p4'
  routing?: MonitoringRouting
  escalation?: { levels?: MonitoringEscalationLevel[] }
}

export interface MonitoringSample {
  cpu_pct?: number | null
  mem_pct?: number | null
  disk_pct?: number | null
  battery_pct?: number | null
  battery_health_pct?: number | null
  network_latency_ms?: number | null
  network_packet_loss_pct?: number | null
  uptime_seconds?: number | null
  process_count?: number | null
  heartbeat_age_seconds?: number | null
  service_states?: Record<string, string>
}

export interface MonitoringEvaluation { evaluated: number; matched: number; raised: number; cleared: number }

export function monitoringConditionMatches(condition: MonitoringCondition, actual: MonitoringScalar): boolean {
  if (typeof actual === 'string' || typeof condition.value === 'string') {
    const left = String(actual).toLowerCase()
    const right = String(condition.value).toLowerCase()
    if (condition.op === 'eq') return left === right
    if (condition.op === 'neq') return left !== right
    if (condition.op === 'contains') return left.includes(right)
    return false
  }
  switch (condition.op) {
    case 'gt': return actual > condition.value
    case 'gte': return actual >= condition.value
    case 'lt': return actual < condition.value
    case 'lte': return actual <= condition.value
    case 'eq': return actual === condition.value
    case 'neq': return actual !== condition.value
    default: return false
  }
}

function renderMessage(template: string | undefined, values: { deviceName: string; metric: MonitoringMetric; value: MonitoringScalar; ruleName: string }): string {
  const fallback = `Monitoring rule "${values.ruleName}" matched on ${values.deviceName}: ${values.metric}=${values.value}`
  return (template ?? fallback).replace(/\{\{\s*(device|metric|value|rule)\s*\}\}/g, (_match, key: string) => ({ device: values.deviceName, metric: values.metric, value: String(values.value), rule: values.ruleName }[key] ?? ''))
}

function isWithinBusinessHours(schedule: Record<string, { start: string; end: string }>, holidays: string[], now: Date): boolean {
  if (!schedule || Object.keys(schedule).length === 0) return true
  if (holidays.includes(now.toISOString().slice(0, 10))) return false
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const window = schedule[days[now.getUTCDay()]]
  if (!window) return false
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
  const [startH, startM] = window.start.split(':').map(Number)
  const [endH, endM] = window.end.split(':').map(Number)
  return minutes >= startH * 60 + startM && minutes < endH * 60 + endM
}

function isInsideMaintenance(windows: Array<{ start?: string; end?: string }>, now: Date): boolean {
  return windows.some((window) => {
    const start = window.start ? Date.parse(window.start) : NaN
    const end = window.end ? Date.parse(window.end) : NaN
    return Number.isFinite(start) && Number.isFinite(end) && now.getTime() >= start && now.getTime() < end
  })
}

async function ruleSuppressed(client: DbClient, rule: { business_hours_id?: string | null; maintenance_windows?: unknown }, now: Date): Promise<boolean> {
  if (isInsideMaintenance(Array.isArray(rule.maintenance_windows) ? rule.maintenance_windows : [], now)) return true
  if (!rule.business_hours_id) return false
  const row = (await client.query('SELECT schedule, holidays FROM business_hours WHERE id = $1', [rule.business_hours_id])).rows[0]
  return Boolean(row && !isWithinBusinessHours(row.schedule ?? {}, row.holidays ?? [], now))
}

async function recipients(client: DbClient, tenantId: string, routing: MonitoringRouting | undefined, fallback: string | null): Promise<string[]> {
  const ids = new Set<string>()
  if (routing?.teamId) {
    // Teams currently expose a lead rather than a separate membership table;
    // routing to a team therefore targets its lead and remains tenant-scoped.
    const lead = await client.query('SELECT lead_id FROM teams WHERE id = $1 AND tenant_id = $2', [routing.teamId, tenantId])
    if (lead.rows[0]?.lead_id) ids.add(lead.rows[0].lead_id)
  }
  for (const id of routing?.userIds ?? []) {
    const exists = await client.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = \'active\'', [tenantId, id])
    if (exists.rows[0]) ids.add(id)
  }
  for (const role of routing?.roles ?? []) {
    const rows = await client.query('SELECT user_id FROM memberships WHERE tenant_id = $1 AND org_role = $2 AND status = \'active\'', [tenantId, role])
    for (const row of rows.rows) ids.add(row.user_id)
  }
  if (ids.size === 0 && fallback) ids.add(fallback)
  return [...ids]
}

async function heldForDuration(client: DbClient, deviceId: string, rule: { metric: MonitoringMetric; condition: MonitoringCondition; min_duration_seconds?: number }, sample: MonitoringSample): Promise<boolean> {
  const seconds = Number(rule.min_duration_seconds ?? 0)
  if (seconds <= 0 || rule.metric === 'heartbeat_age_seconds' || rule.metric === 'service_state') return true
  const rows = (await client.query(
    `SELECT cpu_pct, mem_pct, disk_pct, battery_pct, battery_health_pct, network_latency_ms, uptime_seconds, process_count
       FROM device_metrics WHERE device_id = $1 AND recorded_at >= now() - make_interval(secs => $2)
      ORDER BY recorded_at ASC LIMIT 120`, [deviceId, seconds])).rows
  if (rows.length === 0) return false
  const first = rows[0]
  const current = sample[rule.metric]
  if (current == null) return false
  return rows.every((row) => monitoringConditionMatches(rule.condition, Number(row[rule.metric])) && Number(first[rule.metric]) !== undefined)
}

async function raiseMonitoringAlert(client: DbClient, tenantId: string, device: { id: string; name: string; group_id?: string | null; device_type?: DeviceType }, rule: { id: string; name: string; metric: MonitoringMetric; condition: MonitoringCondition; action: MonitoringAction; business_hours_id?: string | null; maintenance_windows?: unknown; min_duration_seconds?: number }, value: MonitoringScalar): Promise<boolean> {
  if (await ruleSuppressed(client, rule, new Date())) return false
  const open = (await client.query(`SELECT id FROM device_alerts WHERE device_id = $1 AND kind = 'monitoring' AND rule_id = $2 AND resolved_at IS NULL LIMIT 1`, [device.id, rule.id])).rows[0]
  if (open) return false
  const fallback = await firstOwner(client, tenantId)
  const message = renderMessage(rule.action?.message, { deviceName: device.name, metric: rule.metric, value, ruleName: rule.name })
  const inserted = (await client.query(
    `INSERT INTO device_alerts (tenant_id, device_id, kind, rule_id, severity, message)
     VALUES ($1, $2, 'monitoring', $3, $4, $5) RETURNING id`,
    [tenantId, device.id, rule.id, rule.action?.severity ?? 'warning', message],
  )).rows[0]
  if (!inserted) return false
  const targets = await recipients(client, tenantId, rule.action?.routing, fallback)
  for (const userId of targets) await notify(client, tenantId, { userId, kind: 'device.alert', subjectType: 'device', subjectId: device.id, body: message })
  if (rule.action?.createTicket !== false && targets[0]) {
    const ticketId = await createAutomationTicket(client, tenantId, {
      subject: `${rule.action?.severity === 'critical' ? 'Critical ' : ''}Monitoring alert: ${device.name}`,
      body: `${message} A monitoring rule raised this alert automatically.`,
      deviceId: device.id, requesterId: targets[0], priority: rule.action?.ticketPriority,
      teamId: rule.action?.routing?.teamId,
    })
    await client.query('UPDATE device_alerts SET ticket_id = $1 WHERE id = $2', [ticketId, inserted.id])
  }
  return true
}

export async function evaluateMonitoringRules(client: DbClient, tenantId: string, deviceId: string, sample: MonitoringSample): Promise<MonitoringEvaluation> {
  const device = (await client.query('SELECT id, name, group_id, device_type FROM devices WHERE id = $1 AND tenant_id = $2', [deviceId, tenantId])).rows[0] as { id: string; name: string; group_id?: string | null; device_type?: DeviceType } | undefined
  if (!device) return { evaluated: 0, matched: 0, raised: 0, cleared: 0 }
  const activeMetrics = Object.entries(sample).filter(([metric, value]) => metric !== 'service_states' && value != null).map(([metric]) => metric)
  if (sample.service_states && Object.keys(sample.service_states).length > 0) activeMetrics.push('service_state')
  if (activeMetrics.length === 0) return { evaluated: 0, matched: 0, raised: 0, cleared: 0 }
  const rules = (await client.query(
    `SELECT id, name, metric, condition, action, device_type, business_hours_id, maintenance_windows, min_duration_seconds
       FROM alert_rules WHERE tenant_id = $1 AND enabled = true AND metric = ANY($2::text[])
        AND (device_id IS NULL OR device_id = $3) AND (group_id IS NULL OR group_id = $4)
        AND (device_type IS NULL OR device_type = $5) ORDER BY created_at ASC`,
    [tenantId, activeMetrics, deviceId, device.group_id, device.device_type ?? 'workstation'],
  )).rows as Array<{ id: string; name: string; metric: MonitoringMetric; condition: MonitoringCondition; action: MonitoringAction; business_hours_id?: string | null; maintenance_windows?: unknown; min_duration_seconds?: number }>
  const result: MonitoringEvaluation = { evaluated: rules.length, matched: 0, raised: 0, cleared: 0 }
  for (const rule of rules) {
    const raw = rule.metric === 'service_state' ? sample.service_states?.[rule.condition.serviceName ?? ''] : sample[rule.metric]
    if (raw == null) continue
    const matched = monitoringConditionMatches(rule.condition, typeof raw === 'number' ? Number(raw) : raw)
    const open = (await client.query(`SELECT id, ticket_id FROM device_alerts WHERE device_id = $1 AND kind = 'monitoring' AND rule_id = $2 AND resolved_at IS NULL LIMIT 1`, [deviceId, rule.id])).rows[0]
    if (!matched) {
      if (open) {
        await client.query('UPDATE device_alerts SET resolved_at = now() WHERE id = $1', [open.id])
        if (open.ticket_id) await client.query(`INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta) VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`, [tenantId, open.ticket_id, `Monitoring rule "${rule.name}" is clear on ${device.name}.`, JSON.stringify({ event: 'monitoring_rule_cleared', ruleId: rule.id })])
        result.cleared += 1
      }
      continue
    }
    result.matched += 1
    if (open || !(await heldForDuration(client, deviceId, rule, sample))) continue
    if (await raiseMonitoringAlert(client, tenantId, device, rule, raw)) result.raised += 1
  }
  return result
}

export async function evaluateHeartbeatRules(client: DbClient, tenantId: string, deviceId: string, ageSeconds: number): Promise<MonitoringEvaluation> {
  return evaluateMonitoringRules(client, tenantId, deviceId, { heartbeat_age_seconds: ageSeconds })
}

export async function evaluateAnomalies(client: DbClient, tenantId: string, deviceId: string, sample: MonitoringSample): Promise<number> {
  const candidates: Array<[MonitoringMetric, number | null | undefined]> = [
    ['cpu_pct', sample.cpu_pct], ['mem_pct', sample.mem_pct], ['disk_pct', sample.disk_pct], ['network_latency_ms', sample.network_latency_ms],
  ]
  let raised = 0
  const device = (await client.query('SELECT id, name FROM devices WHERE id = $1 AND tenant_id = $2', [deviceId, tenantId])).rows[0]
  if (!device) return 0
  const owner = await firstOwner(client, tenantId)
  for (const [metric, value] of candidates) {
    if (value == null) continue
    const rows = (await client.query(`SELECT ${metric} AS value FROM device_metrics WHERE device_id = $1 AND ${metric} IS NOT NULL ORDER BY recorded_at DESC LIMIT 31`, [deviceId])).rows
    if (rows.length < 12) continue
    const history = rows.slice(1).map((row) => Number(row.value))
    const mean = history.reduce((sum, item) => sum + item, 0) / history.length
    const deviation = Math.sqrt(history.reduce((sum, item) => sum + (item - mean) ** 2, 0) / history.length)
    if (deviation <= 0 || Math.abs(Number(value) - mean) < deviation * 3) continue
    const inserted = (await client.query(`INSERT INTO device_alerts (tenant_id, device_id, kind, severity, message) VALUES ($1, $2, 'anomaly', 'warning', $3) ON CONFLICT DO NOTHING RETURNING id`, [tenantId, deviceId, `${device.name} has an unusual ${metric} reading: ${value} (baseline ${mean.toFixed(1)} ± ${deviation.toFixed(1)}).`])).rows[0]
    if (inserted && owner) { await notify(client, tenantId, { userId: owner, kind: 'device.alert', subjectType: 'device', subjectId: deviceId, body: `Anomaly detected on ${device.name}: ${metric}` }); raised += 1 }
  }
  return raised
}

export async function checkAllMonitoringPolicies(pool: DbPool): Promise<{ heartbeatRules: number; escalations: number }> {
  const tenants = await pool.query('SELECT id FROM tenants')
  const total = { heartbeatRules: 0, escalations: 0 }
  for (const tenant of tenants.rows) {
    try {
      await withTenant(pool, tenant.id, async (client) => {
        const devices = await client.query(`SELECT id, last_seen_at FROM devices WHERE tenant_id = $1`, [tenant.id])
        for (const device of devices.rows) {
          const age = device.last_seen_at ? Math.max(0, Math.floor((Date.now() - new Date(device.last_seen_at).getTime()) / 1000)) : 2_000_000_000
          const result = await evaluateHeartbeatRules(client, tenant.id, device.id, age)
          total.heartbeatRules += result.raised
        }
        total.escalations += await processMonitoringEscalations(client, tenant.id)
      })
    } catch {
      // A malformed tenant rule must not stop monitoring for other tenants.
    }
  }
  return total
}

export async function processMonitoringEscalations(client: DbClient, tenantId: string): Promise<number> {
  const rows = (await client.query(`SELECT a.id, a.device_id, a.created_at, a.escalation_level, a.message, a.severity, d.name, r.action FROM device_alerts a JOIN devices d ON d.id = a.device_id JOIN alert_rules r ON r.id = a.rule_id WHERE a.tenant_id = $1 AND a.kind = 'monitoring' AND a.resolved_at IS NULL AND a.acknowledged_at IS NULL AND (a.snoozed_until IS NULL OR a.snoozed_until < now())`, [tenantId])).rows
  let count = 0
  for (const row of rows) {
    const levels = Array.isArray(row.action?.escalation?.levels) ? row.action.escalation.levels : []
    const nextIndex = Number(row.escalation_level ?? 0)
    const next = levels[nextIndex]
    if (!next || new Date(row.created_at).getTime() + Number(next.afterMinutes) * 60_000 > Date.now()) continue
    const targets = await recipients(client, tenantId, next.routing, await firstOwner(client, tenantId))
    for (const userId of targets) await notify(client, tenantId, { userId, kind: 'device.alert', subjectType: 'device', subjectId: row.device_id, body: `Escalated monitoring alert: ${row.message}` })
    await client.query('UPDATE device_alerts SET escalation_level = $2, escalated_at = now(), severity = COALESCE($3, severity) WHERE id = $1', [row.id, nextIndex + 1, next.severity ?? null])
    count += 1
  }
  return count
}
