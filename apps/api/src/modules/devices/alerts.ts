import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { recordAudit } from '../../core/audit.js'
import { notify } from '../../core/notify.js'
import { createTenantAiProvider } from '../ai/settings.js'
import { createWorkerRun } from '../ai-worker/engine.js'
import { DEFAULT_SLA_MATRIX } from '../tenants/defaults.js'
import { computeDeadlines } from '../tickets/sla.js'
import { checkDeviceAvailabilityForTenant } from './availability.js'

export interface DeviceAlertOpts {
  offlineSec: number
  lowDiskPct: number
  /** Offline conditions may be visible as alerts without creating tickets. */
  createTickets?: boolean
  offlineCreateTickets?: boolean
}

export interface AlertCheckResult {
  offline: number
  lowDisk: number
  tickets: number
  resolved: number
}

/** First active owner of a tenant (fallback requester/notifiee for automation). */
export async function firstOwner(client: DbClient, tenantId: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT m.user_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.org_role = 'owner' AND m.status = 'active' AND u.status = 'active'
      ORDER BY m.created_at ASC
      LIMIT 1`,
    [tenantId],
  )
  return (rows[0]?.user_id as string | undefined) ?? null
}

interface DefaultPolicy {
  id: string
  matrix: Record<string, { response_mins: number; resolution_mins: number }>
  schedule: Record<string, { start: string; end: string }>
}

async function defaultPolicy(client: DbClient, tenantId: string): Promise<DefaultPolicy | null> {
  const { rows } = await client.query(
    `SELECT p.id, p.matrix, COALESCE(b.schedule, '{}'::jsonb) AS schedule
       FROM sla_policies p
       LEFT JOIN business_hours b ON b.id = p.business_hours_id
      WHERE p.tenant_id = $1
      ORDER BY p.is_default DESC, p.created_at ASC
      LIMIT 1`,
    [tenantId],
  )
  if (!rows[0]) return null
  return { id: rows[0].id, matrix: rows[0].matrix, schedule: rows[0].schedule }
}

/**
 * Create an automation ticket linked to a device (counter + SLA deadlines +
 * system-event thread + audit). Runs inside the tenant-scoped transaction.
 */
export async function createAutomationTicket(
  client: DbClient,
  tenantId: string,
  opts: { subject: string; body: string; deviceId: string; requesterId: string; priority?: 'p1' | 'p2' | 'p3' | 'p4'; teamId?: string },
): Promise<string> {
  const policy = (await defaultPolicy(client, tenantId)) ?? {
    id: 'none',
    matrix: DEFAULT_SLA_MATRIX,
    schedule: {},
  }
  const priority = opts.priority ?? 'p3'
  const { dueResponseAt, dueResolutionAt } = computeDeadlines({
    priority,
    matrix: policy.matrix,
    schedule: policy.schedule,
  })

  const counter = await client.query(
    'UPDATE tenants SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter',
    [tenantId],
  )
  const number = counter.rows[0].ticket_counter as number

  const res = await client.query(
    `INSERT INTO tickets
       (tenant_id, number, type, status, priority, subject, requester_id, team_id, device_id, sla_policy_id, source, tags, due_response_at, due_resolution_at)
     VALUES ($1, $2, 'incident', 'new', $3, $4, $5, $6, $7, $8, 'api', '{automation,device}', $9, $10)
     RETURNING id`,
    [
      tenantId, number, priority, opts.subject, opts.requesterId,
      opts.teamId ?? null, opts.deviceId, policy.id === 'none' ? null : policy.id, dueResponseAt, dueResolutionAt,
    ],
  )
  const ticketId = res.rows[0].id as string

  await client.query(
    `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
     VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
    [tenantId, ticketId, opts.body, JSON.stringify({ event: 'device_alert_auto_ticket' })],
  )
  await recordAudit(client, tenantId, {
    actorType: 'system',
    action: 'ticket.created',
    objectType: 'ticket',
    objectId: ticketId,
    payload: { number, subject: opts.subject, automation: 'device_alert', deviceId: opts.deviceId },
  })
  return ticketId
}

async function raiseAlert(
  client: DbClient,
  tenantId: string,
  opts: { deviceId: string; deviceName: string; kind: 'offline' | 'low_disk'; severity: 'warning' | 'critical'; message: string; body: string; createTicket?: boolean },
  workerDeps?: { pool?: DbPool; config: import('../../config.js').AppConfig; fallbackProvider?: import('../ai/gateway.js').AiProvider },
): Promise<number> {
  const ownerId = await firstOwner(client, tenantId)
  if (!ownerId) return 0 // no active owner -> nothing to notify or attribute the ticket to

  const alertRes = await client.query(
    `INSERT INTO device_alerts (tenant_id, device_id, kind, severity, message)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, opts.deviceId, opts.kind, opts.severity, opts.message],
  )
  const alertId = alertRes.rows[0].id as string

  const subject =
    opts.kind === 'offline' ? `Device offline: ${opts.deviceName}` : `Low disk on ${opts.deviceName}`
  let ticketId: string | null = null
  if (opts.createTicket !== false) {
    ticketId = await createAutomationTicket(client, tenantId, {
      subject,
      body: opts.body,
      deviceId: opts.deviceId,
      requesterId: ownerId,
    })
    await client.query('UPDATE device_alerts SET ticket_id = $1 WHERE id = $2', [ticketId, alertId])
  }

  await notify(client, tenantId, {
    userId: ownerId,
    kind: 'device.alert',
    subjectType: 'device',
    subjectId: opts.deviceId,
    body: opts.message,
  })
  const settings = (await client.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings ?? {}
  const workerPolicy = settings.ai_workers ?? {}
  if (workerPolicy.alertAutoStart === true && ticketId && workerDeps?.pool) {
    const tenantAi = await createTenantAiProvider(workerDeps.pool, workerDeps.config, tenantId, workerDeps.fallbackProvider).catch(() => null)
    if (tenantAi) {
      void createWorkerRun(workerDeps.pool, tenantId, ticketId, ownerId, { pool: workerDeps.pool, provider: tenantAi.provider, model: tenantAi.model }, { triggerType: 'device_alert', alertId, estimatedManualMinutes: 45 }).catch(() => undefined)
    }
  }
  return 1
}

/** Evaluate device alerts for one tenant inside its RLS context. */
export async function checkDeviceAlertsForTenant(
  pool: DbPool,
  tenantId: string,
  opts: DeviceAlertOpts,
  _workerDeps?: { pool?: DbPool; config: import('../../config.js').AppConfig; fallbackProvider?: import('../ai/gateway.js').AiProvider },
): Promise<AlertCheckResult> {
  return withTenant(pool, tenantId, async (client) => {
    const result: AlertCheckResult = { offline: 0, lowDisk: 0, tickets: 0, resolved: 0 }

    // -- Policy-driven availability ----------------------------------------
    // This is intentionally isolated from telemetry ingestion. Policies can
    // suppress a laptop on battery or delay ticket creation without affecting
    // the heartbeat/metrics path.
    const availability = await checkDeviceAvailabilityForTenant(client, tenantId, {
      offlineSec: opts.offlineSec,
      offlineCreateTickets: opts.offlineCreateTickets ?? opts.createTickets !== false,
    })
    result.offline += availability.offline
    result.tickets += availability.tickets
    result.resolved += availability.resolved

    // -- Low disk (latest metric per device) --------------------------------
    const lowDisk = await client.query(
      `SELECT DISTINCT ON (m.device_id) m.device_id, m.disk_pct, d.name
         FROM device_metrics m
         JOIN devices d ON d.id = m.device_id
        WHERE d.tenant_id = $1 AND m.disk_pct >= $2
        ORDER BY m.device_id, m.recorded_at DESC`,
      [tenantId, opts.lowDiskPct],
    )
    for (const device of lowDisk.rows) {
      const already = await client.query(
        `SELECT 1 FROM device_alerts a
          WHERE a.device_id = $1 AND a.kind = 'low_disk' AND a.resolved_at IS NULL LIMIT 1`,
        [device.device_id],
      )
      if (already.rows.length > 0) continue
      result.lowDisk += await raiseAlert(client, tenantId, {
        deviceId: device.device_id,
        deviceName: device.name,
        kind: 'low_disk',
        severity: 'critical',
        message: `${device.name} disk usage at ${device.disk_pct}% (>= ${opts.lowDiskPct}%)`,
        body: `Device ${device.name} is at ${device.disk_pct}% disk usage.${opts.createTickets === false ? ' An alert was recorded without opening a ticket.' : ' A support ticket was created automatically.'}`,
        createTicket: opts.createTickets !== false,
      })
    }

    result.tickets += result.lowDisk
    return result
  })
}

/** Sweep every tenant (tenant discovery uses the global tenants table, no RLS). */
export async function checkAllDeviceAlerts(pool: DbPool, opts: DeviceAlertOpts, _workerDeps?: { config: import('../../config.js').AppConfig; fallbackProvider?: import('../ai/gateway.js').AiProvider }): Promise<AlertCheckResult> {
  const { rows } = await pool.query('SELECT id, settings FROM tenants')
  const total: AlertCheckResult = { offline: 0, lowDisk: 0, tickets: 0, resolved: 0 }
  for (const tenant of rows) {
    try {
      const settings = tenant.settings ?? {}
      const configuredMinutes = Number(settings.endpoints?.offline_after_minutes)
      const tenantOpts: DeviceAlertOpts = {
        ...opts,
        offlineSec: Number.isFinite(configuredMinutes) && configuredMinutes >= 1 ? Math.round(configuredMinutes * 60) : opts.offlineSec,
        createTickets: settings.monitoring?.create_tickets_by_default !== false,
        offlineCreateTickets: settings.monitoring?.offline_ticket_mode === 'ticket' && settings.monitoring?.create_tickets_by_default !== false,
      }
      const r = await checkDeviceAlertsForTenant(pool, tenant.id, tenantOpts, workerDeps)
      total.offline += r.offline
      total.lowDisk += r.lowDisk
      total.tickets += r.tickets
      total.resolved += r.resolved
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}

export function startDeviceAlertScheduler(
  pool: DbPool,
  opts: DeviceAlertOpts,
  intervalMs = 60_000,
  workerDeps?: { pool?: DbPool; config: import('../../config.js').AppConfig; fallbackProvider?: import('../ai/gateway.js').AiProvider },
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void checkAllDeviceAlerts(pool, opts, workerDeps).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return timer
}
