import { api } from './api.js'

export type MonitoringMetric = 'cpu_pct' | 'mem_pct' | 'disk_pct'
export type MonitoringOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
export type MonitoringSeverity = 'info' | 'warning' | 'critical'

export interface MonitoringRule {
  id: string
  name: string
  metric: MonitoringMetric
  condition: { op: MonitoringOperator; value: number }
  action: { severity: MonitoringSeverity; message?: string; createTicket: boolean; ticketPriority: 'p1' | 'p2' | 'p3' | 'p4' }
  device_id: string | null
  group_id: string | null
  device_name?: string | null
  group_name?: string | null
  enabled: boolean
  open_alerts?: number
  created_at: string
  updated_at: string
}

export interface MonitoringAlert {
  id: string
  device_id: string
  device_name: string
  kind: string
  rule_id: string
  severity: MonitoringSeverity
  message: string
  ticket_id: string | null
  ticket_number?: number | null
  resolved_at: string | null
  created_at: string
}

export function listMonitoringRules(params: { metric?: MonitoringMetric; enabled?: boolean } = {}): Promise<{ rules: MonitoringRule[] }> {
  const query = new URLSearchParams()
  if (params.metric) query.set('metric', params.metric)
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled))
  const suffix = query.toString() ? `?${query}` : ''
  return api(`/monitoring/rules${suffix}`)
}

export function createMonitoringRule(body: {
  name: string
  metric: MonitoringMetric
  condition: { op: MonitoringOperator; value: number }
  action: { severity: MonitoringSeverity; message?: string; createTicket: boolean; ticketPriority: 'p1' | 'p2' | 'p3' | 'p4' }
  deviceId?: string
  groupId?: string
  enabled?: boolean
}): Promise<{ rule: MonitoringRule }> {
  return api('/monitoring/rules', { method: 'POST', body })
}

export function updateMonitoringRule(id: string, body: Partial<Parameters<typeof createMonitoringRule>[0]>): Promise<{ rule: MonitoringRule }> {
  return api(`/monitoring/rules/${id}`, { method: 'PATCH', body })
}

export function toggleMonitoringRule(id: string, enabled: boolean): Promise<{ rule: Pick<MonitoringRule, 'id' | 'enabled'> }> {
  return api(`/monitoring/rules/${id}/toggle`, { method: 'POST', body: { enabled } })
}

export function deleteMonitoringRule(id: string): Promise<{ ok: true }> {
  return api(`/monitoring/rules/${id}`, { method: 'DELETE' })
}
