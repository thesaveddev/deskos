import type { DbClient } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import { createAutomationTicket, firstOwner } from '../devices/alerts.js'

export const MONITORING_METRICS = ['cpu_pct', 'mem_pct', 'disk_pct'] as const
export type MonitoringMetric = (typeof MONITORING_METRICS)[number]
export const MONITORING_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const
export type MonitoringOperator = (typeof MONITORING_OPERATORS)[number]

export interface MonitoringCondition {
  op: MonitoringOperator
  value: number
}

export interface MonitoringAction {
  severity?: 'info' | 'warning' | 'critical'
  message?: string
  createTicket?: boolean
  ticketPriority?: 'p1' | 'p2' | 'p3' | 'p4'
}

export interface MonitoringSample {
  cpu_pct: number
  mem_pct: number
  disk_pct: number
}

export interface MonitoringEvaluation {
  evaluated: number
  matched: number
  raised: number
  cleared: number
}

export function monitoringConditionMatches(condition: MonitoringCondition, actual: number): boolean {
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

function renderMessage(template: string | undefined, values: { deviceName: string; metric: MonitoringMetric; value: number; ruleName: string }): string {
  const fallback = `Monitoring rule "${values.ruleName}" matched on ${values.deviceName}: ${values.metric}=${values.value}`
  return (template ?? fallback).replace(/\{\{\s*(device|metric|value|rule)\s*\}\}/g, (_match, key: string) => {
    const map: Record<string, string> = {
      device: values.deviceName,
      metric: values.metric,
      value: String(values.value),
      rule: values.ruleName,
    }
    return map[key] ?? ''
  })
}

/**
 * Evaluate all applicable rules for one device. This runs in a tenant-scoped
 * transaction, but is intentionally called after the metric write so a faulty
 * rule can never make endpoint telemetry disappear.
 */
export async function evaluateMonitoringRules(
  client: DbClient,
  tenantId: string,
  deviceId: string,
  sample: MonitoringSample,
): Promise<MonitoringEvaluation> {
  const device = (await client.query(
    'SELECT id, name, group_id FROM devices WHERE id = $1 AND tenant_id = $2',
    [deviceId, tenantId],
  )).rows[0]
  if (!device) return { evaluated: 0, matched: 0, raised: 0, cleared: 0 }

  const rules = (await client.query(
    `SELECT id, name, metric, condition, action
       FROM alert_rules
      WHERE tenant_id = $1 AND enabled = true
        AND metric = ANY($2::text[])
        AND (device_id IS NULL OR device_id = $3)
        AND (group_id IS NULL OR group_id = $4)
      ORDER BY created_at ASC`,
    [tenantId, Object.keys(sample), deviceId, device.group_id],
  )).rows as Array<{
    id: string
    name: string
    metric: MonitoringMetric
    condition: MonitoringCondition
    action: MonitoringAction
  }>

  const result: MonitoringEvaluation = { evaluated: rules.length, matched: 0, raised: 0, cleared: 0 }
  for (const rule of rules) {
    const value = sample[rule.metric]
    const matched = monitoringConditionMatches(rule.condition, Number(value))
    const open = (await client.query(
      `SELECT id, ticket_id FROM device_alerts
        WHERE device_id = $1 AND kind = 'monitoring' AND rule_id = $2 AND resolved_at IS NULL
        LIMIT 1`,
      [deviceId, rule.id],
    )).rows[0]

    if (!matched) {
      if (open) {
        await client.query('UPDATE device_alerts SET resolved_at = now() WHERE id = $1', [open.id])
        if (open.ticket_id) {
          await client.query(
            `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
             VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
            [tenantId, open.ticket_id, `Monitoring rule "${rule.name}" is clear on ${device.name}.`, JSON.stringify({ event: 'monitoring_rule_cleared', ruleId: rule.id })],
          )
        }
        result.cleared += 1
      }
      continue
    }

    result.matched += 1
    if (open) continue

    const action = rule.action ?? {}
    const severity = action.severity ?? 'warning'
    const message = renderMessage(action.message, {
      deviceName: device.name,
      metric: rule.metric,
      value: Number(value),
      ruleName: rule.name,
    })
    const inserted = (await client.query(
      `INSERT INTO device_alerts (tenant_id, device_id, kind, rule_id, severity, message)
       VALUES ($1, $2, 'monitoring', $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [tenantId, deviceId, rule.id, severity, message],
    )).rows[0]
    if (!inserted) continue

    result.raised += 1
    const ownerId = await firstOwner(client, tenantId)
    if (ownerId) {
      await notify(client, tenantId, {
        userId: ownerId,
        kind: 'device.alert',
        subjectType: 'device',
        subjectId: deviceId,
        body: message,
      })
      if (action.createTicket !== false) {
        const ticketId = await createAutomationTicket(client, tenantId, {
          subject: `${severity === 'critical' ? 'Critical ' : ''}Monitoring alert: ${device.name}`,
          body: `${message} A monitoring rule raised this alert automatically.`,
          deviceId,
          requesterId: ownerId,
          priority: action.ticketPriority,
        })
        await client.query('UPDATE device_alerts SET ticket_id = $1 WHERE id = $2', [ticketId, inserted.id])
      }
    }
  }
  return result
}
