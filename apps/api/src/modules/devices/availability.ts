import type { DbClient } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import { createAutomationTicket, firstOwner } from './alerts.js'

export type AvailabilityDeviceType = 'laptop' | 'workstation' | 'server' | 'network_device' | 'mobile' | 'other'
export type AvailabilityTicketMode = 'alert' | 'ticket'

export interface AvailabilityFallback {
  offlineSec: number
  offlineCreateTickets?: boolean
}

export interface AvailabilityEvaluation {
  offline: number
  tickets: number
  resolved: number
}

interface AvailabilityPolicy {
  id: string | null
  name: string
  group_id: string | null
  device_type: AvailabilityDeviceType | null
  offline_threshold_minutes: number
  grace_period_minutes: number
  alert_delay_minutes: number
  ticket_delay_minutes: number
  ticket_mode: AvailabilityTicketMode
  timezone: string
  business_hours_id: string | null
  maintenance_windows: unknown
  suppress_power_states: unknown
  critical_override: boolean
  recovery_notifications: boolean
}

interface DeviceRow {
  id: string
  name: string
  group_id: string | null
  device_type: AvailabilityDeviceType | null
  power_source: string | null
  last_seen_at: string | Date | null
}

function fallbackPolicy(opts: AvailabilityFallback): AvailabilityPolicy {
  return {
    id: null,
    name: 'Tenant default availability',
    group_id: null,
    device_type: null,
    offline_threshold_minutes: Math.max(1, Math.ceil(opts.offlineSec / 60)),
    grace_period_minutes: 0,
    alert_delay_minutes: 0,
    ticket_delay_minutes: 0,
    ticket_mode: opts.offlineCreateTickets === false ? 'alert' : 'ticket',
    timezone: 'UTC',
    business_hours_id: null,
    maintenance_windows: [],
    suppress_power_states: [],
    critical_override: false,
    recovery_notifications: true,
  }
}

function validTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return timezone
  } catch {
    return 'UTC'
  }
}

function localParts(now: Date, timezone: string): { date: string; minutes: number; day: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: validTimezone(timezone), weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]))
  const day = String(parts.weekday ?? 'Sun').slice(0, 3).toLowerCase()
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), day }
}

function withinBusinessHours(schedule: unknown, holidays: unknown, timezone: string, now: Date): boolean {
  if (!schedule || typeof schedule !== 'object' || Object.keys(schedule).length === 0) return true
  const local = localParts(now, timezone)
  if (Array.isArray(holidays) && holidays.includes(local.date)) return false
  const window = (schedule as Record<string, { start?: string; end?: string }>)[local.day]
  if (!window?.start || !window.end) return false
  const [startH, startM] = window.start.split(':').map(Number)
  const [endH, endM] = window.end.split(':').map(Number)
  if (![startH, startM, endH, endM].every(Number.isFinite)) return false
  const start = startH * 60 + startM
  const end = endH * 60 + endM
  return end >= start ? local.minutes >= start && local.minutes < end : local.minutes >= start || local.minutes < end
}

function insideMaintenance(windows: unknown, now: Date): boolean {
  if (!Array.isArray(windows)) return false
  return windows.some((window) => {
    if (!window || typeof window !== 'object') return false
    const start = Date.parse(String((window as { start?: string }).start ?? ''))
    const end = Date.parse(String((window as { end?: string }).end ?? ''))
    return Number.isFinite(start) && Number.isFinite(end) && now.getTime() >= start && now.getTime() < end
  })
}

async function suppressionReason(client: DbClient, policy: AvailabilityPolicy, device: DeviceRow, now: Date): Promise<string | null> {
  if (policy.critical_override) return null
  const power = (device.power_source || 'unknown').toLowerCase()
  if (Array.isArray(policy.suppress_power_states) && policy.suppress_power_states.includes(power)) return `power state is ${power}`
  if (insideMaintenance(policy.maintenance_windows, now)) return 'inside a maintenance window'
  if (policy.business_hours_id) {
    const row = (await client.query('SELECT schedule, holidays FROM business_hours WHERE id = $1', [policy.business_hours_id])).rows[0]
    if (row && !withinBusinessHours(row.schedule, row.holidays, policy.timezone, now)) return `outside ${policy.timezone} working hours`
  }
  return null
}

async function resolvePolicy(client: DbClient, tenantId: string, device: DeviceRow, fallback: AvailabilityFallback): Promise<AvailabilityPolicy> {
  const row = (await client.query(
    `SELECT id, name, group_id, device_type, offline_threshold_minutes, grace_period_minutes,
            alert_delay_minutes, ticket_delay_minutes, ticket_mode, timezone, business_hours_id,
            maintenance_windows, suppress_power_states, critical_override, recovery_notifications
       FROM device_availability_policies
      WHERE tenant_id = $1 AND enabled = true
        AND (group_id IS NULL OR group_id = $2)
        AND (device_type IS NULL OR device_type = $3)
      ORDER BY critical_override DESC,
               CASE WHEN group_id = $2 THEN 1 ELSE 0 END DESC,
               CASE WHEN device_type = $3 THEN 1 ELSE 0 END DESC,
               priority DESC, created_at DESC
      LIMIT 1`,
    [tenantId, device.group_id, device.device_type],
  )).rows[0] as AvailabilityPolicy | undefined
  return row ?? fallbackPolicy(fallback)
}

async function createAvailabilityAlert(client: DbClient, tenantId: string, device: DeviceRow, policy: AvailabilityPolicy, offlineMinutes: number, now: Date): Promise<{ created: boolean; alertId?: string }> {
  const existing = (await client.query(
    `SELECT id FROM device_alerts WHERE device_id = $1 AND kind = 'offline' AND resolved_at IS NULL LIMIT 1`,
    [device.id],
  )).rows[0]
  if (existing) return { created: false }
  const ownerId = await firstOwner(client, tenantId)
  if (!ownerId) return { created: false }
  const severity = policy.critical_override ? 'critical' : 'warning'
  const message = `${device.name} has not reported for ${Math.round(offlineMinutes)} minutes (${policy.name}).`
  const dueAt = policy.ticket_mode === 'ticket'
    ? new Date(now.getTime() + Math.max(0, policy.ticket_delay_minutes * 60_000) - (policy.ticket_delay_minutes === 0 ? 1000 : 0))
    : null
  const inserted = (await client.query(
    `INSERT INTO device_alerts
       (tenant_id, device_id, kind, severity, message, availability_policy_id, ticket_due_at, availability_alert)
     VALUES ($1, $2, 'offline', $3, $4, $5, $6, true)
     ON CONFLICT DO NOTHING RETURNING id`,
    [tenantId, device.id, severity, message, policy.id, dueAt],
  )).rows[0]
  if (!inserted) return { created: false }
  await notify(client, tenantId, { userId: ownerId, kind: 'device.alert', subjectType: 'device', subjectId: device.id, body: message })
  return { created: true, alertId: inserted.id }
}

async function createDueTicket(client: DbClient, tenantId: string, alert: { id: string; device_id: string; device_name: string; message: string }): Promise<boolean> {
  const ownerId = await firstOwner(client, tenantId)
  if (!ownerId) return false
  const ticketId = await createAutomationTicket(client, tenantId, {
    subject: `Device offline: ${alert.device_name}`,
    body: `${alert.message} The availability policy's ticket escalation delay has elapsed.`,
    deviceId: alert.device_id,
    requesterId: ownerId,
    priority: 'p3',
  })
  await client.query('UPDATE device_alerts SET ticket_id = $2 WHERE id = $1 AND ticket_id IS NULL', [alert.id, ticketId])
  return true
}

export async function checkDeviceAvailabilityForTenant(client: DbClient, tenantId: string, fallback: AvailabilityFallback): Promise<AvailabilityEvaluation> {
  const result: AvailabilityEvaluation = { offline: 0, tickets: 0, resolved: 0 }
  const now = new Date()
  const devices = (await client.query(
    `SELECT d.id, d.name, d.group_id, d.device_type, d.power_source, d.last_seen_at
       FROM devices d
      WHERE d.tenant_id = $1 AND d.adhoc = false AND d.last_seen_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM remote_sessions rs WHERE rs.device_id = d.id AND rs.state IN ('active', 'connecting', 'consent_pending'))`,
    [tenantId],
  )).rows as DeviceRow[]

  for (const device of devices) {
    const policy = await resolvePolicy(client, tenantId, device, fallback)
    const lastSeen = new Date(device.last_seen_at as string | Date)
    const offlineMinutes = Math.max(0, (now.getTime() - lastSeen.getTime()) / 60_000)
    const threshold = policy.offline_threshold_minutes + policy.grace_period_minutes + policy.alert_delay_minutes
    const suppression = await suppressionReason(client, policy, device, now)
    const staleEnough = offlineMinutes >= threshold
    const open = (await client.query(
      `SELECT a.id, a.ticket_id, a.ticket_due_at, d.name AS device_name, a.message
         FROM device_alerts a JOIN devices d ON d.id = a.device_id
        WHERE d.adhoc = false AND a.device_id = $1 AND a.kind = 'offline' AND a.resolved_at IS NULL
        LIMIT 1`,
      [device.id],
    )).rows[0] as { id: string; ticket_id: string | null; ticket_due_at: string | null; device_name: string; message: string } | undefined

    if (staleEnough && !suppression && !open) {
      const created = await createAvailabilityAlert(client, tenantId, device, policy, offlineMinutes, now)
      if (created.created) {
        result.offline += 1
        // A zero ticket delay is an explicit synchronous escalation. Do it
        // here rather than relying on the next scheduler tick.
        if (policy.ticket_mode === 'ticket' && policy.ticket_delay_minutes === 0 && created.alertId) {
          const ticketCreated = await createDueTicket(client, tenantId, { id: created.alertId, device_id: device.id, device_name: device.name, message: `${device.name} is offline.` })
          if (ticketCreated) result.tickets += 1
        }
      }
    }
    if (staleEnough) {
      const presence = (await client.query('SELECT status FROM device_presence_events WHERE device_id = $1 ORDER BY observed_at DESC LIMIT 1', [device.id])).rows[0]
      if (presence?.status !== 'offline') await client.query(`INSERT INTO device_presence_events (tenant_id, device_id, status, source) VALUES ($1, $2, 'offline', 'availability_policy')`, [tenantId, device.id])
    }
  }

  const due = (await client.query(
    `SELECT a.id, a.device_id, a.message, d.name AS device_name
       FROM device_alerts a JOIN devices d ON d.id = a.device_id
      WHERE d.adhoc = false AND a.tenant_id = $1 AND a.kind = 'offline' AND a.availability_alert = true
        AND a.resolved_at IS NULL AND a.ticket_id IS NULL AND a.ticket_due_at IS NOT NULL AND a.ticket_due_at <= now()`,
    [tenantId],
  )).rows as Array<{ id: string; device_id: string; message: string; device_name: string }>
  for (const alert of due) if (await createDueTicket(client, tenantId, alert)) result.tickets += 1

  const recovered = (await client.query(
    `UPDATE device_alerts a SET resolved_at = now()
       FROM devices d
      WHERE d.adhoc = false AND a.device_id = d.id AND a.kind = 'offline' AND a.resolved_at IS NULL
        AND d.last_seen_at > a.created_at
      RETURNING a.id, a.ticket_id, a.device_id, d.name, a.availability_policy_id`,
  )).rows as Array<{ id: string; ticket_id: string | null; device_id: string; name: string; availability_policy_id: string | null }>
  for (const alert of recovered) {
    result.resolved += 1
    const policy = alert.availability_policy_id
      ? (await client.query('SELECT recovery_notifications FROM device_availability_policies WHERE id = $1', [alert.availability_policy_id])).rows[0]
      : { recovery_notifications: true }
    if (policy?.recovery_notifications !== false) {
      const body = `Device ${alert.name} is back online and has reported again.`
      if (alert.ticket_id) await client.query(`INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta) VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`, [tenantId, alert.ticket_id, body, JSON.stringify({ event: 'device_back_online' })])
      const ownerId = await firstOwner(client, tenantId)
      if (ownerId) await notify(client, tenantId, { userId: ownerId, kind: 'device.alert', subjectType: 'device', subjectId: alert.device_id, body })
    }
  }
  return result
}
