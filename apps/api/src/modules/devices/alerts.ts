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
  /** device_metrics rows deleted by the retention sweep. */
  prunedMetrics?: number
}

/**
 * Telemetry retention: delete metric samples older than the horizon. Runs
 * alongside the alert sweep; a single bounded DELETE per tick keeps tables
 * small without locking. Sampled series older than the horizon have no
 * dashboard use (sparklines show the last 12 samples). Pruning a device's
 * history does NOT fabricate recovery — recovery is driven by fresh metrics.
 */
export async function pruneDeviceMetrics(pool: DbPool, retentionDays: number): Promise<number> {
  const days = Number.isFinite(retentionDays) && retentionDays >= 1 ? Math.floor(retentionDays) : 30
  // device_metrics is RLS-protected, so deletion must run inside each tenant's
  // context — mirroring how checkAllDeviceAlerts sweeps tenants.
  const { rows: tenants } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of tenants) {
    try {
      const result = await withTenant(pool, tenant.id, (client) =>
        client.query(
          `WITH deleted AS (DELETE FROM device_metrics WHERE recorded_at < now() - ($1 || ' days')::interval RETURNING 1)
           SELECT count(*)::int AS deleted FROM deleted`,
          [days],
        ),
      )
      total += result.rows[0]?.deleted ?? 0
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}

/**
 * Fleet housekeeping: hard-delete devices retired more than `purgeDays` ago
 * (default 90). Retirement already revoked the agent and ended its sessions;
 * this removes the stale record — and with it the cascaded session/metric
 * history — so the inventory does not fill with decommissioned hardware.
 *
 * Guardrails:
 *  - purges only enrolled (adhoc = false) devices, mirroring the manual
 *    DELETE /devices/:id route
 *  - skips devices that somehow still have a live session
 *  - records a `device.purged` audit event BEFORE the delete (audit_logs has
 *    no FK to devices, so the trail survives the cascade and names what the
 *    job removed)
 *  - purgeDays <= 0 disables the job entirely
 */
export async function purgeExpiredRetiredDevices(pool: DbPool, purgeDays: number): Promise<number> {
  const days = Number.isFinite(purgeDays) ? Math.floor(purgeDays) : 90
  if (days <= 0) return 0
  const { rows: tenants } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of tenants) {
    try {
      await withTenant(pool, tenant.id, async (client) => {
        const { rows: stale } = await client.query(
          `SELECT d.id, d.name, d.retired_at
             FROM devices d
            WHERE d.adhoc = false
              AND d.retired_at IS NOT NULL
              AND d.retired_at < now() - ($1 || ' days')::interval
              AND NOT EXISTS (
                SELECT 1 FROM remote_sessions s
                 WHERE s.device_id = d.id
                   AND s.state IN ('requested', 'consent_pending', 'connecting', 'active', 'reconnecting')
              )`,
          [days],
        )
        for (const device of stale) {
          await recordAudit(client, tenant.id, {
            actorType: 'system',
            action: 'device.purged',
            objectType: 'device',
            objectId: device.id as string,
            payload: {
              name: device.name,
              retiredAt: device.retired_at,
              retentionDays: days,
              reason: 'retired_device_retention',
            },
          })
          await client.query('DELETE FROM devices WHERE id = $1', [device.id])
          total += 1
        }
      })
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
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
          AND m.recorded_at > now() - interval '7 days'
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

    // -- Low disk recovery ---------------------------------------------------
    // Alerts were raised once and never resolved: after freeing space, the open
    // alert blocked any future low-disk alert for that device forever. Resolve
    // when the device's freshest metric is under the threshold (and within the
    // same 7-day freshness window used to raise alerts).
    const recovered = await client.query(
      `UPDATE device_alerts a SET resolved_at = now()
        FROM (
          SELECT DISTINCT ON (m.device_id) m.device_id, m.disk_pct
            FROM device_metrics m
            JOIN devices d ON d.id = m.device_id
           WHERE d.tenant_id = $1 AND m.recorded_at > now() - interval '7 days'
           ORDER BY m.device_id, m.recorded_at DESC
        ) latest
       WHERE a.device_id = latest.device_id
         AND a.kind = 'low_disk' AND a.resolved_at IS NULL
         AND latest.disk_pct < $2
       RETURNING a.id, a.device_id`,
      [tenantId, opts.lowDiskPct],
    )
    for (const alert of recovered.rows) {
      result.resolved += 1
      const deviceRow = (await client.query('SELECT name FROM devices WHERE id = $1', [alert.device_id])).rows[0]
      const body = `Disk usage on ${deviceRow?.name ?? 'device'} is back under ${opts.lowDiskPct}%.`
      const ownerId = await firstOwner(client, tenantId)
      if (ownerId) await notify(client, tenantId, { userId: ownerId, kind: 'device.alert', subjectType: 'device', subjectId: alert.device_id, body })
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
      const r = await checkDeviceAlertsForTenant(pool, tenant.id, tenantOpts, _workerDeps)
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
  opts: DeviceAlertOpts & { metricsRetentionDays?: number },
  intervalMs = 60_000,
  workerDeps?: { pool?: DbPool; config: import('../../config.js').AppConfig; fallbackProvider?: import('../ai/gateway.js').AiProvider },
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void checkAllDeviceAlerts(pool, opts, workerDeps).catch(() => undefined)
    void pruneDeviceMetrics(pool, opts.metricsRetentionDays ?? 30).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return timer
}
