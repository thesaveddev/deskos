import { api } from './api.js'

export type DeviceType = 'laptop' | 'workstation' | 'server' | 'network_device' | 'mobile' | 'other'
export type MonitoringMetric = 'cpu_pct' | 'mem_pct' | 'disk_pct' | 'battery_pct' | 'battery_health_pct' | 'network_latency_ms' | 'uptime_seconds' | 'process_count' | 'heartbeat_age_seconds' | 'service_state'
export type MonitoringOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'contains'
export type MonitoringSeverity = 'info' | 'warning' | 'critical'

export interface MonitoringRule {
  id: string
  name: string
  metric: MonitoringMetric
  condition: { op: MonitoringOperator; value: number | string; serviceName?: string }
  action: { severity: MonitoringSeverity; message?: string; createTicket: boolean; ticketPriority: 'p1' | 'p2' | 'p3' | 'p4'; routing?: { teamId?: string; userIds?: string[]; roles?: string[] }; escalation?: { levels?: Array<{ afterMinutes: number; severity?: MonitoringSeverity }> } }
  device_id: string | null
  group_id: string | null
  device_type?: DeviceType | null
  business_hours_id?: string | null
  maintenance_windows?: Array<{ start: string; end: string }>
  min_duration_seconds?: number
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
  acknowledged_at?: string | null
  acknowledged_by?: string | null
  snoozed_until?: string | null
  escalation_level?: number
  created_at: string
}

export interface MonitoringBusinessHours { id: string; name: string; schedule: Record<string, { start: string; end: string }>; holidays: string[] }

export function listMonitoringBusinessHours(): Promise<{ businessHours: MonitoringBusinessHours[] }> {
  return api('/monitoring/business-hours')
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
  condition: { op: MonitoringOperator; value: number | string; serviceName?: string }
  action: { severity: MonitoringSeverity; message?: string; createTicket: boolean; ticketPriority: 'p1' | 'p2' | 'p3' | 'p4'; routing?: { teamId?: string; userIds?: string[]; roles?: string[] }; escalation?: { levels?: Array<{ afterMinutes: number; severity?: MonitoringSeverity }> } }
  deviceId?: string
  groupId?: string
  deviceType?: DeviceType
  businessHoursId?: string | null
  maintenanceWindows?: Array<{ start: string; end: string }>
  minDurationSeconds?: number
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

export interface MonitoringOverview {
  devices: Array<{ device_type: DeviceType; total: number; online: number }>
  alerts: Array<{ severity: MonitoringSeverity; total: number; unacknowledged: number }>
  health: { cpu_pct: number | null; mem_pct: number | null; disk_pct: number | null; network_latency_ms: number | null; battery_pct: number | null } | null
  trend: Array<{ day: string; samples: number; cpu_pct: number; mem_pct: number; disk_pct: number }>
}

export interface AvailabilityPolicy {
  id: string
  name: string
  group_id: string | null
  group_name?: string | null
  device_type: DeviceType | null
  priority: number
  offline_threshold_minutes: number
  grace_period_minutes: number
  alert_delay_minutes: number
  ticket_delay_minutes: number
  ticket_mode: 'alert' | 'ticket'
  timezone: string
  business_hours_id: string | null
  business_hours_name?: string | null
  maintenance_windows: Array<{ start: string; end: string; label?: string }>
  suppress_power_states: Array<'ac' | 'battery' | 'unknown'>
  critical_override: boolean
  recovery_notifications: boolean
  enabled: boolean
  open_alerts?: number
  created_at: string
  updated_at: string
}

export interface AvailabilityPolicyInput {
  name: string
  groupId?: string | null
  deviceType?: DeviceType | null
  priority?: number
  offlineThresholdMinutes?: number
  gracePeriodMinutes?: number
  alertDelayMinutes?: number
  ticketDelayMinutes?: number
  ticketMode?: 'alert' | 'ticket'
  timezone?: string
  businessHoursId?: string | null
  maintenanceWindows?: Array<{ start: string; end: string; label?: string }>
  suppressPowerStates?: Array<'ac' | 'battery' | 'unknown'>
  criticalOverride?: boolean
  recoveryNotifications?: boolean
  enabled?: boolean
}

export function listAvailabilityPolicies(): Promise<{ policies: AvailabilityPolicy[] }> {
  return api('/monitoring/availability-policies')
}

export function createAvailabilityPolicy(body: AvailabilityPolicyInput): Promise<{ policy: AvailabilityPolicy }> {
  return api('/monitoring/availability-policies', { method: 'POST', body })
}

export function updateAvailabilityPolicy(id: string, body: Partial<AvailabilityPolicyInput>): Promise<{ policy: AvailabilityPolicy }> {
  return api(`/monitoring/availability-policies/${id}`, { method: 'PATCH', body })
}

export function deleteAvailabilityPolicy(id: string): Promise<{ ok: true }> {
  return api(`/monitoring/availability-policies/${id}`, { method: 'DELETE' })
}

export function getMonitoringOverview(): Promise<MonitoringOverview> {
  return api('/monitoring/overview')
}

export function acknowledgeDeviceAlert(id: string): Promise<unknown> {
  return api(`/device-alerts/${id}/acknowledge`, { method: 'POST', body: {} })
}

export function snoozeDeviceAlert(id: string, minutes: number): Promise<unknown> {
  return api(`/device-alerts/${id}/snooze`, { method: 'POST', body: { minutes } })
}
