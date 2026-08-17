import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { checkUpdate } from '../../core/update.js'
import { withTenant } from '../../db/pool.js'
import { evaluateDevice } from '../dex/dex.js'
import { evaluateMonitoringRules } from '../monitoring/monitoring.js'
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
})

const heartbeatSchema = z.object({}).strict()

const inventorySchema = z.object({
  hostname: z.string().max(255).optional(),
  os: z.string().max(40).optional(),
  osVersion: z.string().max(80).optional(),
  arch: z.string().max(40).optional(),
  ip: z.string().max(64).optional(),
  agentVersion: z.string().max(40).optional(),
})

const metricsSchema = z.object({
  cpuPct: z.number().min(0).max(100),
  memPct: z.number().min(0).max(100),
  diskPct: z.number().min(0).max(100),
})

const updateTelemetrySchema = z.object({
  fromVersion: z.string().max(40),
  toVersion: z.string().max(40),
  outcome: z.enum(['checked', 'downloaded', 'verified', 'applied', 'failed', 'rolled_back']),
  reason: z.string().max(500).optional(),
})

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

    const deviceToken = `deskos_dev_${randomBytes(24).toString('base64url')}`

    const created = await withTenant(app.db, tenantId, async (client) => {
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
           (tenant_id, name, hostname, os, os_version, arch, ip_address, agent_version, agent_token_hash, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         RETURNING id, name`,
        [
          tenantId, name, body.hostname ?? '', body.os ?? '', body.osVersion ?? '',
          body.arch ?? '', body.ip ?? '', body.agentVersion ?? '', hashToken(deviceToken),
        ],
      )
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

    return reply.code(201).send({
      device: { id: created.id, name: created.name },
      deviceToken,
      heartbeatIntervalSec: 30,
    })
  })

  // -- Heartbeat: mark the device alive; resolves open offline alerts --------
  app.post('/agent/heartbeat', { preHandler: [authenticateAgent] }, async (request, _reply) => {
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
      // Resolve any open offline alert for this device (back online).
      const alerts = await client.query(
        `UPDATE device_alerts SET resolved_at = now()
          WHERE device_id = $1 AND kind = 'offline' AND resolved_at IS NULL
         RETURNING ticket_id`,
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
      }
      return res.rows[0]
    })

    return { ok: true, device: updated }
  })

  // -- Inventory: update device facts ----------------------------------------
  app.put('/agent/inventory', { preHandler: [authenticateAgent] }, async (request) => {
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
      ] as const) {
        const value = body[key]
        if (value !== undefined) {
          values.push(value)
          sets.push(`${col} = $${values.length}`)
        }
      }
      values.push(ctx.deviceId, ctx.tenantId)
      const res = await client.query(
        `UPDATE devices SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now()
          WHERE id = $${values.length - 1} AND tenant_id = $${values.length}
         RETURNING id, name`,
        values,
      )
      if (!res.rows[0]) throw AppError.notFound('Device not found')
      return { ok: true, device: res.rows[0] }
    })
  })

  // -- Metrics: record a sample (CPU/mem/disk) -------------------------------
  app.post('/agent/metrics', { preHandler: [authenticateAgent] }, async (request) => {
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
        `INSERT INTO device_metrics (tenant_id, device_id, cpu_pct, mem_pct, disk_pct)
         VALUES ($1, $2, $3, $4, $5)`,
        [ctx.tenantId, ctx.deviceId, body.cpuPct, body.memPct, body.diskPct],
      )
    })

    // Telemetry must remain reliable even if an individual monitoring rule is
    // malformed or its ticket action cannot be created.
    try {
      await withTenant(app.db, ctx.tenantId, (client) => evaluateMonitoringRules(client, ctx.tenantId, ctx.deviceId, {
        cpu_pct: body.cpuPct,
        mem_pct: body.memPct,
        disk_pct: body.diskPct,
      }))
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

  // -- Updates: offer the configured release via a deterministic rollout ring --
  app.get('/agent/update', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const query = request.query as { version?: string }
    const currentVersion = typeof query.version === 'string' && query.version.trim() ? query.version.trim() : '0.0.0'
    return checkUpdate(app.config.update, ctx.deviceId, currentVersion)
  })

  app.post('/agent/update/telemetry', { preHandler: [authenticateAgent] }, async (request, reply) => {
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
