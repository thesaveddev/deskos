import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { checkUpdate } from '../../core/update.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { evaluateDevice, recordExperienceEvent } from '../dex/dex.js'
import { evaluateAnomalies, evaluateMonitoringRules } from '../monitoring/monitoring.js'
import { notify } from '../../core/notify.js'
import { firstOwner } from './alerts.js'
import { authenticateAgent, hashToken } from './device-auth.js'
import '../../types.js'

const enrolSchema = z.object({
  // Eight-digit human codes and opaque fleet tokens are both accepted here.
  token: z.string().min(6).max(200),
  name: z.string().min(1).max(120).optional(),
  hostname: z.string().min(1).max(255).optional(),
  os: z.string().max(40).optional(),
  osVersion: z.string().max(80).optional(),
  arch: z.string().max(40).optional(),
  ip: z.string().max(64).optional(),
  agentVersion: z.string().max(40).optional(),
  deviceType: z.enum(['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other']).optional(),
  serialNumber: z.string().max(200).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
})

const heartbeatSchema = z.object({}).strict()

const inventorySchema = z.object({
  hostname: z.string().max(255).optional(),
  os: z.string().max(40).optional(),
  osVersion: z.string().max(80).optional(),
  arch: z.string().max(40).optional(),
  ip: z.string().max(64).optional(),
  agentVersion: z.string().max(40).optional(),
  deviceType: z.enum(['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other']).optional(),
  powerSource: z.string().max(40).optional(),
  batteryPct: z.number().min(0).max(100).nullable().optional(),
  batteryHealthPct: z.number().min(0).max(100).nullable().optional(),
  uptimeSeconds: z.number().int().min(0).max(2_000_000_000).optional(),
  serialNumber: z.string().max(200).optional(),
  manufacturer: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
})

const metricsSchema = z.object({
  cpuPct: z.number().min(0).max(100),
  memPct: z.number().min(0).max(100),
  diskPct: z.number().min(0).max(100),
  diskFreeBytes: z.number().int().min(0).optional(),
  networkLatencyMs: z.number().min(0).max(60_000).nullable().optional(),
  networkPacketLossPct: z.number().min(0).max(100).nullable().optional(),
  batteryPct: z.number().min(0).max(100).nullable().optional(),
  batteryHealthPct: z.number().min(0).max(100).nullable().optional(),
  uptimeSeconds: z.number().int().min(0).max(2_000_000_000).optional(),
  processCount: z.number().int().min(0).max(1_000_000).optional(),
  serviceStates: z.record(z.string().max(120), z.enum(['running', 'stopped', 'paused', 'unknown'])).optional(),
  reason: z.string().max(40).optional(),
})

const updateTelemetrySchema = z.object({
  fromVersion: z.string().max(40),
  toVersion: z.string().max(40),
  outcome: z.enum(['checked', 'downloaded', 'verified', 'applied', 'failed', 'rolled_back']),
  reason: z.string().max(500).optional(),
})

/**
 * Link directory-discovered devices (Entra/Intune or on-prem AD) to the live
 * agent device once they can be recognised by serial number. Matching is
 * best-effort: it must never break enrolment or inventory reporting.
 */
async function matchDirectoryDevices(client: DbClient, tenantId: string, deviceId: string, serial: string | undefined): Promise<number> {
  const normalized = serial?.trim()
  if (!normalized) return 0
  const result = await client.query(
    `UPDATE devices
        SET agent_device_id = $1, updated_at = now()
      WHERE tenant_id = $2
        AND id <> $1
        AND source <> 'agent'
        AND serial_number <> ''
        AND lower(serial_number) = lower($3)
        AND (agent_device_id IS NULL OR agent_device_id <> $1)`,
    [deviceId, tenantId, normalized],
  )
  return result.rowCount ?? 0
}

/**
 * Agent-facing endpoints. Auth = per-device bearer token issued at enrolment
 * (never a user JWT). Agent endpoints still run inside the device's tenant via
 * the RLS transaction, so a stolen token is scoped to one device + tenant.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  // -- Enrol: prove the tenant enrolment token, get a device identity --------
  app.post('/agent/enrol', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = enrolSchema.parse(request.body)

    // Tenant discovery via the tenants table (deliberately RLS-free, like the
    // SLA scheduler's tenant sweep). Both opaque fleet tokens and short human
    // codes are stored as sha256 hashes; codes also require an unused expiry.
    const credentialHash = hashToken(body.token)
    const tokenRow = await app.db.query(
      `SELECT id,
              CASE
                WHEN enrol_token_hash = $1 AND enrol_token_revoked_at IS NULL THEN 'fleet_token'
                WHEN enrol_code_hash = $1
                  AND enrol_code_used_at IS NULL
                  AND enrol_code_expires_at > now() THEN 'enrol_code'
              END AS credential_type
         FROM tenants
        WHERE (enrol_token_hash = $1 AND enrol_token_revoked_at IS NULL)
           OR (enrol_code_hash = $1 AND enrol_code_used_at IS NULL AND enrol_code_expires_at > now())
        LIMIT 1`,
      [credentialHash],
    )
    const tenantId = tokenRow.rows[0]?.id as string | undefined
    const credentialType = tokenRow.rows[0]?.credential_type as 'fleet_token' | 'enrol_code' | undefined
    if (!tenantId || !credentialType) throw AppError.unauthorized('Invalid, expired, or already used enrollment code')

    // Enforce device plan cap (skip for fleet-token re-enrolments and free-tier tenants)
    if (credentialType === 'enrol_code') {
      const planRow = (await app.db.query(
        `SELECT p.max_devices FROM tenant_subscriptions s
           JOIN subscription_plans p ON p.id = s.plan_id
          WHERE s.tenant_id = $1 AND s.status IN ('active', 'trialing')
          ORDER BY s.created_at DESC LIMIT 1`,
        [tenantId],
      )).rows[0]
      if (planRow) {
        const deviceCap = Number(planRow.max_devices) || 10
        const currentCount = (await app.db.query(
          'SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND adhoc = false',
          [tenantId],
      )).rows[0]?.n as number
        if (currentCount >= deviceCap) {
          throw AppError.forbidden(
            `Device limit reached (${currentCount}/${deviceCap}) on this plan. Upgrade to add more endpoints.`,
            'plan_limit_exceeded',
          )
        }
      }
    }

    const deviceToken = `deskos_dev_${randomBytes(24).toString('base64url')}`

    const created = await withTenant(app.db, tenantId, async (client) => {
      // Fleet deployment scripts can be retried by Intune/GPO. Reuse the
      // existing endpoint identity when the same hostname checks in instead
      // of creating a second or third device record.
      if (credentialType === 'fleet_token' && body.hostname && body.name) {
        const existing = (await client.query(
          `SELECT id, name FROM devices WHERE tenant_id = $1 AND lower(hostname) = lower($2) AND lower(name) = lower($3) ORDER BY updated_at DESC LIMIT 1`,
          [tenantId, body.hostname, body.name],
        )).rows[0]
        if (existing) {
          await client.query(
            `UPDATE devices SET hostname = COALESCE(NULLIF($2, ''), hostname), os = COALESCE(NULLIF($3, ''), os),
                    os_version = COALESCE(NULLIF($4, ''), os_version), arch = COALESCE(NULLIF($5, ''), arch),
                    ip_address = COALESCE(NULLIF($6, ''), ip_address), agent_version = COALESCE(NULLIF($7, ''), agent_version),
                    device_type = COALESCE(NULLIF($8, ''), device_type), serial_number = COALESCE(NULLIF($9, ''), serial_number),
                    manufacturer = COALESCE(NULLIF($10, ''), manufacturer), model = COALESCE(NULLIF($11, ''), model),
                    agent_token_hash = $12, last_seen_at = now(), updated_at = now()
              WHERE id = $1`,
            [existing.id, body.hostname ?? '', body.os ?? '', body.osVersion ?? '', body.arch ?? '', body.ip ?? '', body.agentVersion ?? '', body.deviceType ?? '', body.serialNumber ?? '', body.manufacturer ?? '', body.model ?? '', hashToken(deviceToken)],
          )
          await matchDirectoryDevices(client, tenantId, existing.id, body.serialNumber)
          return existing
        }
      }
      if (credentialType === 'enrol_code') {
        const consumed = await client.query(
          `UPDATE tenants
              SET enrol_code_used_at = now()
            WHERE id = $1
              AND enrol_code_hash = $2
              AND enrol_code_used_at IS NULL
              AND enrol_code_expires_at > now()
           RETURNING id`,
          [tenantId, credentialHash],
        )
        if (!consumed.rowCount) throw AppError.unauthorized('Enrollment code expired or already used')
      }
      const name = body.name ?? body.hostname ?? 'Unnamed device'
      const res = await client.query(
        `INSERT INTO devices
           (tenant_id, name, hostname, os, os_version, arch, ip_address, agent_version, device_type,
            serial_number, manufacturer, model, agent_token_hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         RETURNING id, name`,
        [
          tenantId, name, body.hostname ?? '', body.os ?? '', body.osVersion ?? '',
          body.arch ?? '', body.ip ?? '', body.agentVersion ?? '', body.deviceType ?? 'workstation',
          body.serialNumber ?? '', body.manufacturer ?? '', body.model ?? '', hashToken(deviceToken),
        ],
      )
      await matchDirectoryDevices(client, tenantId, res.rows[0].id, body.serialNumber)
      await recordAudit(client, tenantId, {
        actorType: 'agent',
        action: 'device.enrolled',
        objectType: 'device',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { name, hostname: body.hostname ?? null, os: body.os ?? null, credentialType },
      })
      return res.rows[0]
    })

    const tenantSettings = (await app.db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings ?? {}
    const heartbeatIntervalSec = Number(tenantSettings.endpoints?.heartbeat_interval_seconds ?? 30)
    return reply.code(201).send({
      device: { id: created.id, name: created.name },
      deviceToken,
      heartbeatIntervalSec,
    })
  })

  // -- Heartbeat: mark the device alive; resolves open offline alerts --------
  app.post('/agent/heartbeat', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, _reply) => {
    heartbeatSchema.parse(request.body ?? {})
    const ctx = request.deviceCtx!

    const updated = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE devices SET last_seen_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2
         RETURNING id, name`,
        [ctx.deviceId, ctx.tenantId],
      )
      if (!res.rows[0]) throw AppError.notFound('Device not found')
      const lastPresence = (await client.query('SELECT status FROM device_presence_events WHERE device_id = $1 ORDER BY observed_at DESC LIMIT 1', [ctx.deviceId])).rows[0]
      if (lastPresence?.status !== 'online') {
        await client.query(`INSERT INTO device_presence_events (tenant_id, device_id, status, source) VALUES ($1, $2, 'online', 'heartbeat')`, [ctx.tenantId, ctx.deviceId])
      }
      // Resolve any open offline alert for this device (back online).
      const alerts = await client.query(
        `UPDATE device_alerts SET resolved_at = now()
          WHERE device_id = $1 AND kind = 'offline' AND resolved_at IS NULL
         RETURNING ticket_id, availability_policy_id`,

        [ctx.deviceId],
      )
      for (const alert of alerts.rows) {
        if (alert.ticket_id) {
          await client.query(
            `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
             VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
            [ctx.tenantId, alert.ticket_id, 'Device is back online (heartbeat received).', JSON.stringify({ event: 'device_back_online' })],
          )
        }
        const policy = alert.availability_policy_id
          ? (await client.query('SELECT recovery_notifications FROM device_availability_policies WHERE id = $1', [alert.availability_policy_id])).rows[0]
          : { recovery_notifications: true }
        if (policy?.recovery_notifications !== false) {
          const ownerId = await firstOwner(client, ctx.tenantId)
          if (ownerId) await notify(client, ctx.tenantId, { userId: ownerId, kind: 'device.alert', subjectType: 'device', subjectId: ctx.deviceId, body: 'Device is back online and has reported again.' })
        }
      }
      return res.rows[0]
    })

    return { ok: true, device: updated }
  })

  // -- Inventory: update device facts ----------------------------------------
  app.put('/agent/inventory', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const body = inventorySchema.parse(request.body)
    const ctx = request.deviceCtx!

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const sets: string[] = []
      const values: unknown[] = []
      for (const [col, key] of [
        ['hostname', 'hostname'],
        ['os', 'os'],
        ['os_version', 'osVersion'],
        ['arch', 'arch'],
        ['ip_address', 'ip'],
        ['agent_version', 'agentVersion'],
        ['device_type', 'deviceType'],
        ['power_source', 'powerSource'],
        ['battery_pct', 'batteryPct'],
        ['battery_health_pct', 'batteryHealthPct'],
        ['uptime_seconds', 'uptimeSeconds'],
        ['serial_number', 'serialNumber'],
        ['manufacturer', 'manufacturer'],
        ['model', 'model'],
      ] as const) {
        const value = body[key]
        if (value !== undefined) {
          values.push(value)
          sets.push(`${col} = $${values.length}`)
        }
      }
      values.push(ctx.deviceId, ctx.tenantId)
      const res = await client.query(
        `UPDATE devices SET ${sets.length ? sets.join(', ') + ', ' : ''}last_seen_at = now(), last_inventory_at = now(), updated_at = now()
          WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
         RETURNING id, name`,
        values,
      )
      if (!res.rows[0]) throw AppError.notFound('Device not found')
      await matchDirectoryDevices(client, ctx.tenantId, ctx.deviceId, body.serialNumber)
      return { ok: true, device: res.rows[0] }
    })
  })

  // -- Metrics: record a sample (CPU/mem/disk) -------------------------------
  app.post('/agent/metrics', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const body = metricsSchema.parse(request.body)
    const ctx = request.deviceCtx!

    await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE devices SET last_seen_at = now(), updated_at = now()
          WHERE id = $1 AND tenant_id = $2
         RETURNING id`,
        [ctx.deviceId, ctx.tenantId],
      )
      if (!res.rows[0]) throw AppError.notFound('Device not found')
      await client.query(
        `INSERT INTO device_metrics
           (tenant_id, device_id, cpu_pct, mem_pct, disk_pct, disk_free_bytes, network_latency_ms, network_packet_loss_pct, battery_pct, battery_health_pct, uptime_seconds, process_count, service_states, recorded_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [ctx.tenantId, ctx.deviceId, body.cpuPct, body.memPct, body.diskPct, body.diskFreeBytes ?? null, body.networkLatencyMs ?? null, body.networkPacketLossPct ?? null, body.batteryPct ?? null, body.batteryHealthPct ?? null, body.uptimeSeconds ?? null, body.processCount ?? null, JSON.stringify(body.serviceStates ?? {}), body.reason ?? 'periodic'],
      )
    })

    // Telemetry must remain reliable even if an individual monitoring rule is
    // malformed or its ticket action cannot be created.
    try {
      await withTenant(app.db, ctx.tenantId, async (client) => {
        await evaluateMonitoringRules(client, ctx.tenantId, ctx.deviceId, {
          cpu_pct: body.cpuPct,
          mem_pct: body.memPct,
          disk_pct: body.diskPct,
          battery_pct: body.batteryPct,
          battery_health_pct: body.batteryHealthPct,
          network_latency_ms: body.networkLatencyMs,
          network_packet_loss_pct: body.networkPacketLossPct,
          uptime_seconds: body.uptimeSeconds,
          process_count: body.processCount,
          service_states: body.serviceStates,
        })
        await evaluateAnomalies(client, ctx.tenantId, ctx.deviceId, {
          cpu_pct: body.cpuPct,
          mem_pct: body.memPct,
          disk_pct: body.diskPct,
          network_latency_ms: body.networkLatencyMs,
        })
      })
    } catch (err) {
      request.log.warn({ err, deviceId: ctx.deviceId }, 'monitoring rule evaluation failed')
    }

    // DEX score + posture evaluation are best-effort and never fail telemetry.
    try {
      await withTenant(app.db, ctx.tenantId, (client) => evaluateDevice(client, ctx.tenantId, ctx.deviceId))
    } catch (err) {
      request.log.warn({ err, deviceId: ctx.deviceId }, 'dex evaluation failed')
    }

    return { ok: true }
  })

  // -- DEX application experience events ------------------------------------
  // These are raw real-user-monitoring facts; scoring remains best-effort and
  // can be recomputed later when an organization changes its weights.
  app.post('/agent/dex/events', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const body = z.object({
      userId: z.string().uuid().nullable().optional(),
      applicationName: z.string().trim().min(1).max(200),
      eventType: z.enum(['launch', 'crash', 'hang', 'close', 'login']),
      durationMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
      successful: z.boolean().nullable().optional(),
      metadata: z.record(z.unknown()).optional(),
    }).parse(request.body)
    const ctx = request.deviceCtx!
    await withTenant(app.db, ctx.tenantId, (client) => recordExperienceEvent(client, ctx.tenantId, ctx.deviceId, body))
    try {
      await withTenant(app.db, ctx.tenantId, (client) => evaluateDevice(client, ctx.tenantId, ctx.deviceId))
    } catch (err) {
      request.log.warn({ err, deviceId: ctx.deviceId }, 'dex experience evaluation failed')
    }
    return { ok: true }
  })

  // -- Updates: offer the configured release via a deterministic rollout ring --
  app.get('/agent/update/health', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const query = request.query as { version?: string }
    const currentVersion = typeof query.version === 'string' && query.version.trim() ? query.version.trim() : '0.0.0'
    const checkedAt = new Date().toISOString()
    const result = checkUpdate(app.config.update, ctx.deviceId, currentVersion)
    await withTenant(app.db, ctx.tenantId, (client) => recordAudit(client, ctx.tenantId, {
      actorType: 'agent', actorId: ctx.deviceId, action: 'agent.update.health_checked', objectType: 'device', objectId: ctx.deviceId,
      ip: request.ip, payload: { currentVersion, status: result.status, configured: result.status !== 'not_configured' },
    }))
    return { ok: true, checkedAt, currentVersion, status: result.status, configured: result.status !== 'not_configured', offer: result.update ? { version: result.update.version, url: result.update.url, sha256: result.update.sha256, rolloutPercent: result.update.rolloutPercent } : null }
  })

  app.get('/agent/update', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const ctx = request.deviceCtx!
    const query = request.query as { version?: string }
    const currentVersion = typeof query.version === 'string' && query.version.trim() ? query.version.trim() : '0.0.0'
    return checkUpdate(app.config.update, ctx.deviceId, currentVersion)
  })

  app.post('/agent/update/telemetry', { preHandler: [authenticateAgent], config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = updateTelemetrySchema.parse(request.body)
    const ctx = request.deviceCtx!
    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorType: 'agent',
        actorId: ctx.deviceId,
        action: `agent.update.${body.outcome}`,
        objectType: 'device',
        objectId: ctx.deviceId,
        ip: request.ip,
        payload: {
          fromVersion: body.fromVersion,
          toVersion: body.toVersion,
          reason: body.reason ?? null,
        },
      }),
    )
    return reply.code(204).send()
  })
}
