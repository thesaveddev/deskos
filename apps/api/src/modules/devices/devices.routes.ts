import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { rotateEnrolToken } from './device-auth.js'
import '../../types.js'

const devicePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  groupId: z.string().uuid().nullable().optional(),
  deviceType: z.enum(['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other']).optional(),
})

const groupCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
  matchRules: z.array(z.unknown()).max(50).optional(),
})

const groupPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().uuid().nullable().optional(),
  matchRules: z.array(z.unknown()).max(50).optional(),
})

const assignmentStatus = z.enum(['assigned', 'shared', 'temporary'])
const assignmentSchema = z.object({
  userId: z.string().uuid().nullable().optional(),
  assignmentStatus: assignmentStatus.default('assigned'),
  department: z.string().trim().max(160).default(''),
  teamId: z.string().uuid().nullable().optional(),
  location: z.string().trim().max(160).default(''),
  expectedReturnAt: z.string().datetime({ offset: true }).nullable().optional(),
  reason: z.string().trim().max(500).default(''),
  notes: z.string().trim().max(5_000).default(''),
})

const returnAssignmentSchema = z.object({
  notes: z.string().trim().max(5_000).optional(),
})

const OFFLINE_SQL = (secs: number) =>
  `CASE
     WHEN EXISTS (
       SELECT 1 FROM remote_sessions rs
        WHERE rs.device_id = d.id
          AND rs.state IN ('active', 'connecting', 'consent_pending')
     ) THEN 'online'
     WHEN d.last_seen_at IS NULL THEN 'never'
     WHEN d.last_seen_at >= now() - make_interval(secs => ${secs}) THEN 'online'
     ELSE 'offline'
   END`

function isUuid(value: string | undefined): boolean {
  return value !== undefined && z.string().uuid().safeParse(value).success
}

/**
 * Staff-facing device management. Read = `device.read`, write = `device.manage`.
 * Agent-facing routes live in agent.routes.ts (device-token auth).
 */
export async function deviceRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant] as const
  const tenantOfflineSec = async (tenantId: string): Promise<number> => {
    const settings = (await app.db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])).rows[0]?.settings ?? {}
    const minutes = Number(settings.endpoints?.offline_after_minutes)
    return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : app.config.deviceOfflineSec
  }

  // -- Device assignment lifecycle -------------------------------------------
  app.get('/members/:userId/device-assignments', { preHandler: [...guards, requirePermission('member.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { userId } = request.params as { userId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const member = (await client.query('SELECT u.id, u.name, u.email, m.status FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = $1 AND m.tenant_id = $2', [userId, ctx.tenantId])).rows[0]
      if (!member) throw AppError.notFound('Staff member not found')
      const devices = (await client.query(
        `SELECT a.*, d.name AS device_name, d.hostname, d.ip_address, d.last_seen_at, d.device_type, t.name AS team_name
           FROM device_assignments a JOIN devices d ON d.id = a.device_id
           LEFT JOIN teams t ON t.id = a.team_id
          WHERE d.adhoc = false AND a.user_id = $1 ORDER BY a.assigned_at DESC`,
        [userId],
      )).rows
      const assets = (await client.query(
        `SELECT id, tag, name, type, status, device_id, location, warranty_until
           FROM assets WHERE owner_id = $1 ORDER BY name`,
        [userId],
      )).rows
      const licences = (await client.query(
        `SELECT la.id AS assignment_id, la.licence_id, l.name, la.seats, la.assigned_at, la.reason
           FROM licence_assignments la JOIN licences l ON l.id = la.licence_id
          WHERE la.user_id = $1 AND la.ended_at IS NULL ORDER BY l.name`,
        [userId],
      )).rows
      return { member, assignedDevices: devices, ownedAssets: assets, assignedLicences: licences, offboarding: { activeAssignments: devices.filter((item) => !item.ended_at).length, activeLicences: licences.length, lastDeviceCheckIn: devices.map((item) => item.last_seen_at).filter(Boolean).sort().at(-1) ?? null } }
    })
  })

  app.get('/device-assignments', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { status?: string; unassigned?: string; limit?: string }
    const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500)
    const clauses = ['d.tenant_id = $1', 'd.adhoc = false']
    const values: unknown[] = [ctx.tenantId]
    if (query.status === 'active') clauses.push('da.ended_at IS NULL')
    if (query.status === 'returned') clauses.push("da.assignment_status = 'returned'")
    if (query.unassigned === 'true' || query.unassigned === '1') {
      clauses.push('da.id IS NULL')
    }
    const rows = await withTenant(app.db, ctx.tenantId, (client) => client.query(
      `SELECT d.id AS device_id, d.name AS device_name, d.hostname, d.ip_address, d.device_type,
              a.id AS assignment_id, a.assignment_status, a.assigned_at, a.returned_at,
              a.expected_return_at, a.department, a.location, a.reason, a.notes,
              u.id AS user_id, u.name AS user_name, u.email AS user_email,
              ab.name AS assigned_by_name, t.name AS team_name
         FROM devices d
         LEFT JOIN device_assignments a ON a.device_id = d.id AND a.ended_at IS NULL
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN users ab ON ab.id = a.assigned_by
         LEFT JOIN teams t ON t.id = a.team_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY d.name ASC LIMIT $2`,
      [...values, limit],
    ).then((result) => result.rows))
    return { assignments: rows }
  })

  app.get('/devices/:id/assignments', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const device = (await client.query('SELECT id, name FROM devices WHERE id = $1 AND adhoc = false', [id])).rows[0]
      if (!device) throw AppError.notFound('Device not found')
      const result = await client.query(
        `SELECT a.*, u.name AS user_name, u.email AS user_email,
                ab.name AS assigned_by_name, t.name AS team_name
           FROM device_assignments a
           LEFT JOIN users u ON u.id = a.user_id
           LEFT JOIN users ab ON ab.id = a.assigned_by
           LEFT JOIN teams t ON t.id = a.team_id
          WHERE a.device_id = $1
          ORDER BY a.assigned_at DESC`,
        [id],
      )
      return { device, current: result.rows.find((row) => !row.ended_at) ?? null, assignments: result.rows }
    })
  })

  app.post('/devices/:id/assignments', { preHandler: [...guards, requirePermission('device.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = assignmentSchema.parse(request.body)
    if (body.assignmentStatus === 'shared' && body.userId) throw AppError.badRequest('A shared device cannot have a primary user', 'shared_assignment_user')
    if (body.assignmentStatus !== 'shared' && !body.userId) throw AppError.badRequest('Select a staff member or choose Shared device', 'assignment_user_required')

    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      const device = (await client.query('SELECT id FROM devices WHERE id = $1 AND adhoc = false', [id])).rows[0]
      if (!device) throw AppError.notFound('Device not found')
      if (body.userId) {
        const member = (await client.query("SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'", [ctx.tenantId, body.userId])).rows[0]
        if (!member) throw AppError.badRequest('The selected staff member is not active in this organization', 'assignment_user_invalid')
      }
      if (body.teamId) {
        const team = (await client.query('SELECT 1 FROM teams WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, body.teamId])).rows[0]
        if (!team) throw AppError.badRequest('The selected team does not belong to this organization', 'assignment_team_invalid')
      }
      await client.query(
        `UPDATE device_assignments
            SET ended_at = COALESCE(ended_at, now()), returned_at = COALESCE(returned_at, now()), assignment_status = CASE WHEN ended_at IS NULL THEN 'returned' ELSE assignment_status END,
                audit_event = CASE WHEN ended_at IS NULL THEN 'device.assignment.replaced' ELSE audit_event END
          WHERE device_id = $1 AND ended_at IS NULL`,
        [id],
      )
      const result = await client.query(
        `INSERT INTO device_assignments
           (tenant_id, device_id, user_id, assigned_by, department, team_id, location,
            assignment_status, expected_return_at, reason, notes, audit_event)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'device.assignment.created')
         RETURNING *`,
        [ctx.tenantId, id, body.userId ?? null, request.user!.id, body.department, body.teamId ?? null,
          body.location, body.assignmentStatus, body.expectedReturnAt ?? null, body.reason, body.notes],
      )
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'device.assignment.created',
        objectType: 'device_assignment',
        objectId: result.rows[0].id,
        ip: request.ip,
        payload: { deviceId: id, userId: body.userId ?? null, assignmentStatus: body.assignmentStatus, reason: body.reason },
      })
      return result.rows[0]
    })
    return reply.code(201).send({ assignment: created })
  })

  app.post('/devices/:id/assignments/:assignmentId/return', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, assignmentId } = request.params as { id: string; assignmentId: string }
    const body = returnAssignmentSchema.parse(request.body ?? {})
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query(
        'SELECT id FROM device_assignments WHERE id = $1 AND device_id = $2 AND ended_at IS NULL',
        [assignmentId, id],
      )).rows[0]
      if (!current) throw AppError.notFound('Active device assignment not found')
      const result = await client.query(
        `UPDATE device_assignments
            SET ended_at = now(), returned_at = now(), assignment_status = 'returned',
                notes = CASE WHEN $3::text IS NULL OR $3::text = '' THEN notes ELSE $3::text END,
                audit_event = 'device.assignment.returned'
          WHERE id = $1 AND device_id = $2
          RETURNING *`,
        [assignmentId, id, body.notes ?? null],
      )
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'device.assignment.returned',
        objectType: 'device_assignment',
        objectId: assignmentId,
        ip: request.ip,
        payload: { deviceId: id },
      })
      return { assignment: result.rows[0] }
    })
  })

  // -- Devices ---------------------------------------------------------------
  app.get('/devices', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { q?: string; groupId?: string; status?: string; deviceType?: string; limit?: string; offset?: string; cursor?: string }
    const clauses: string[] = ['d.adhoc = false']
    const values: unknown[] = []
    if (q.q) {
      values.push(`%${q.q}%`)
      clauses.push(`(d.name ILIKE $${values.length} OR d.hostname ILIKE $${values.length} OR d.os ILIKE $${values.length})`)
    }
    if (q.deviceType && ['laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'].includes(q.deviceType)) {
      values.push(q.deviceType)
      clauses.push(`d.device_type = $${values.length}`)
    }
    if (q.groupId && isUuid(q.groupId)) {
      values.push(q.groupId)
      clauses.push(`d.group_id = $${values.length}`)
    }
    const statusExpr = OFFLINE_SQL(await tenantOfflineSec(ctx.tenantId))
    if (q.status === 'online' || q.status === 'offline' || q.status === 'never') {
      clauses.push(`${statusExpr} = $${values.length + 1}`)
      values.push(q.status)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.min(Number(q.limit ?? 50), 200)
    const offset = Math.max(0, Number(q.offset ?? 0))

    // Count total
    const countResult = await withTenant(app.db, ctx.tenantId, (client) =>
      client.query(`SELECT COUNT(*)::int AS total FROM devices d ${where}`, values).then((r) => r.rows[0]),
    )
    const total = countResult?.total ?? 0

    // Fetch page
    const rows = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT d.id, d.name, d.hostname, d.os, d.os_version, d.arch, d.ip_address,
                  d.agent_version, d.device_type, d.power_source, d.battery_pct, d.battery_health_pct, d.uptime_seconds, d.last_inventory_at,
                  d.source, d.managed_by, d.serial_number, d.manufacturer, d.model, d.directory_last_seen_at,
                  d.agent_device_id,
                  d.group_id, d.enrolled_at, d.last_seen_at, d.created_at,
                  g.name AS group_name,
                  a.tag AS asset_tag, da.assignment_status, au.name AS assigned_user_name, au.email AS assigned_user_email, da.department AS assigned_department,
                  ad.name AS linked_agent_name, ad.hostname AS linked_agent_hostname,
                  ${statusExpr} AS status
           FROM devices d
           LEFT JOIN device_groups g ON g.id = d.group_id
             LEFT JOIN assets a ON a.device_id = d.id
             LEFT JOIN device_assignments da ON da.device_id = d.id AND da.ended_at IS NULL
             LEFT JOIN users au ON au.id = da.user_id
             LEFT JOIN devices ad ON ad.id = d.agent_device_id
             ${where}
            ORDER BY d.created_at DESC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, limit, offset],
        )
        .then((r) => r.rows),
    )
    return { devices: rows, total, nextCursor: null }
  })

  app.get('/devices/:id', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const statusExpr = OFFLINE_SQL(await tenantOfflineSec(ctx.tenantId))
      const device = (
        await client.query(
          `SELECT d.id, d.tenant_id, d.group_id, d.name, d.hostname, d.os, d.os_version,
                  d.arch, d.ip_address, d.agent_version, d.device_type, d.power_source, d.battery_pct, d.battery_health_pct, d.uptime_seconds, d.last_inventory_at,
                  d.source, d.managed_by, d.serial_number, d.manufacturer, d.model, d.directory_last_seen_at,
                  d.agent_device_id,
                  NULL::text AS agent_token_hash,
                  d.enrolled_at, d.last_seen_at, d.created_at, d.updated_at,
                  g.name AS group_name,
                  ad.name AS linked_agent_name, ad.hostname AS linked_agent_hostname,
                  ${statusExpr} AS status
           FROM devices d
           LEFT JOIN device_groups g ON g.id = d.group_id
             LEFT JOIN devices ad ON ad.id = d.agent_device_id
            WHERE d.id = $1 AND d.adhoc = false`,
          [id],
        )
      ).rows[0]
      if (!device) throw AppError.notFound('Device not found')

      const metrics = (
        await client.query(            `SELECT id, cpu_pct, mem_pct, disk_pct, disk_free_bytes, network_latency_ms, network_packet_loss_pct,
                    battery_pct, battery_health_pct, uptime_seconds, process_count, service_states, recorded_reason, recorded_at
             FROM device_metrics
            WHERE device_id = $1
            ORDER BY recorded_at DESC
            LIMIT 60`,
          [id],
        )
      ).rows.map((row) => ({
        ...row,
        cpu_pct: Number(row.cpu_pct),
        mem_pct: Number(row.mem_pct),
        disk_pct: Number(row.disk_pct),
        disk_free_bytes: row.disk_free_bytes == null ? null : Number(row.disk_free_bytes),
        network_latency_ms: row.network_latency_ms == null ? null : Number(row.network_latency_ms),
        network_packet_loss_pct: row.network_packet_loss_pct == null ? null : Number(row.network_packet_loss_pct),
        battery_pct: row.battery_pct == null ? null : Number(row.battery_pct),
        battery_health_pct: row.battery_health_pct == null ? null : Number(row.battery_health_pct),
        uptime_seconds: row.uptime_seconds == null ? null : Number(row.uptime_seconds),
        process_count: row.process_count == null ? null : Number(row.process_count),
      }))
      const alerts = (
        await client.query(
          `SELECT a.*, t.number AS ticket_number
             FROM device_alerts a
             LEFT JOIN tickets t ON t.id = a.ticket_id
            WHERE a.device_id = $1
            ORDER BY a.created_at DESC
            LIMIT 25`,
          [id],
        )
      ).rows
      const tickets = (
        await client.query(
          `SELECT id, number, subject, status, priority, created_at
             FROM tickets
            WHERE device_id = $1
            ORDER BY created_at DESC
            LIMIT 25`,
          [id],
        )
      ).rows
      const assignments = (
        await client.query(
          `SELECT a.*, u.name AS user_name, u.email AS user_email,
                  ab.name AS assigned_by_name, t.name AS team_name
             FROM device_assignments a
             LEFT JOIN users u ON u.id = a.user_id
             LEFT JOIN users ab ON ab.id = a.assigned_by
             LEFT JOIN teams t ON t.id = a.team_id
            WHERE a.device_id = $1
            ORDER BY a.assigned_at DESC`,
          [id],
        )
      ).rows
      const asset = (
        await client.query(
          `SELECT id, tag, name, type, status, qr_payload, barcode_value, warranty_until
             FROM assets WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [id],
        )
      ).rows[0] ?? null
      return { device, metrics: metrics.reverse(), alerts, tickets, assignment: assignments.find((row) => !row.ended_at) ?? null, assignments, asset }
    })
  })

  app.patch('/devices/:id', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = devicePatchSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM devices WHERE id = $1 AND adhoc = false', [id])).rows[0]
      if (!current) throw AppError.notFound('Device not found')

      const sets: string[] = []
      const values: unknown[] = []
      if (body.name !== undefined) {
        values.push(body.name)
        sets.push(`name = $${values.length}`)
      }
      if (body.groupId !== undefined) {
        values.push(body.groupId)
        sets.push(`group_id = $${values.length}`)
      }
      if (body.deviceType !== undefined) {
        values.push(body.deviceType)
        sets.push(`device_type = $${values.length}`)
      }
      if (sets.length === 0) throw AppError.badRequest('Nothing to update')
      values.push(id)
      const res = await client.query(
        `UPDATE devices SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
        values,
      )
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'device.updated',
        objectType: 'device',
        objectId: id,
        ip: request.ip,
        payload: { changes: body },
      })
      return { device: res.rows[0] }
    })
  })

  app.delete('/devices/:id', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM devices WHERE id = $1 AND adhoc = false', [id])).rows[0]
      if (!current) throw AppError.notFound('Device not found')
      await client.query('DELETE FROM devices WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'device.deleted',
        objectType: 'device',
        objectId: id,
        ip: request.ip,
      })
      return { ok: true }
    })
  })

  // -- Device groups ----------------------------------------------------------
  app.get('/device-groups', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const rows = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT g.id, g.name, g.parent_id, g.match_rules, g.created_at,
                  p.name AS parent_name,
                  count(d.id)::int AS device_count
             FROM device_groups g
             LEFT JOIN device_groups p ON p.id = g.parent_id
             LEFT JOIN devices d ON d.group_id = g.id AND d.adhoc = false
            GROUP BY g.id, p.name
            ORDER BY lower(g.name) ASC`,
        )
        .then((r) => r.rows),
    )
    return { groups: rows }
  })

  app.post('/device-groups', { preHandler: [...guards, requirePermission('device.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = groupCreateSchema.parse(request.body)

    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      try {
        const res = await client.query(
          `INSERT INTO device_groups (tenant_id, name, parent_id, match_rules)
           VALUES ($1, $2, $3, $4::jsonb) RETURNING *`,
          [ctx.tenantId, body.name, body.parentId ?? null, JSON.stringify(body.matchRules ?? [])],
        )
        await recordAudit(client, ctx.tenantId, {
          actorId: request.user!.id,
          action: 'device_group.created',
          objectType: 'device_group',
          objectId: res.rows[0].id,
          ip: request.ip,
          payload: { name: body.name },
        })
        return res.rows[0]
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw AppError.conflict('A device group with this name already exists', 'group_exists')
        }
        throw err
      }
    })
    return reply.code(201).send({ group: created })
  })

  app.patch('/device-groups/:id', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = groupPatchSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM device_groups WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Device group not found')

      const sets: string[] = []
      const values: unknown[] = []
      for (const field of ['name', 'parentId', 'matchRules'] as const) {
        const value = body[field]
        if (value !== undefined) {
          const column = field === 'parentId' ? 'parent_id' : field === 'matchRules' ? 'match_rules' : field
          values.push(field === 'matchRules' ? JSON.stringify(value) : value)
          sets.push(`${column} = $${values.length}${field === 'matchRules' ? '::jsonb' : ''}`)
        }
      }
      if (sets.length === 0) throw AppError.badRequest('Nothing to update')
      values.push(id)
      try {
        const res = await client.query(
          `UPDATE device_groups SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
          values,
        )
        await recordAudit(client, ctx.tenantId, {
          actorId: request.user!.id,
          action: 'device_group.updated',
          objectType: 'device_group',
          objectId: id,
          ip: request.ip,
          payload: { changes: body },
        })
        return { group: res.rows[0] }
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw AppError.conflict('A device group with this name already exists', 'group_exists')
        }
        throw err
      }
    })
  })

  app.delete('/device-groups/:id', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM device_groups WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Device group not found')
      // Devices keep existing; group_id is SET NULL by the FK.
      await client.query('DELETE FROM device_groups WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'device_group.deleted',
        objectType: 'device_group',
        objectId: id,
        ip: request.ip,
      })
      return { ok: true }
    })
  })

  // -- Alerts feed -------------------------------------------------------------
  app.get('/device-alerts', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { open?: string }
    const openOnly = q.open === 'true' || q.open === '1'
    const rows = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT a.*, d.name AS device_name, t.number AS ticket_number
             FROM device_alerts a
             JOIN devices d ON d.id = a.device_id
             LEFT JOIN tickets t ON t.id = a.ticket_id
            WHERE d.adhoc = false${openOnly ? ' AND a.resolved_at IS NULL' : ''}
            ORDER BY a.created_at DESC
            LIMIT 100`,
        )
        .then((r) => r.rows),
    )
    return { alerts: rows }
  })

  app.post('/device-alerts/:id/acknowledge', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(`UPDATE device_alerts SET acknowledged_at = COALESCE(acknowledged_at, now()), acknowledged_by = COALESCE(acknowledged_by, $2) WHERE id = $1 AND resolved_at IS NULL RETURNING id, acknowledged_at, acknowledged_by`, [id, request.user!.id])
      if (!result.rows[0]) throw AppError.notFound('Open device alert not found')
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'device_alert.acknowledged', objectType: 'device_alert', objectId: id, ip: request.ip })
      return { alert: result.rows[0] }
    })
  })

  app.post('/device-alerts/:id/snooze', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = z.object({ minutes: z.number().int().min(5).max(43_200) }).parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query(`UPDATE device_alerts SET snoozed_until = now() + make_interval(mins => $2) WHERE id = $1 AND resolved_at IS NULL RETURNING id, snoozed_until`, [id, body.minutes])
      if (!result.rows[0]) throw AppError.notFound('Open device alert not found')
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'device_alert.snoozed', objectType: 'device_alert', objectId: id, ip: request.ip, payload: { minutes: body.minutes } })
      return { alert: result.rows[0] }
    })
  })

  // -- Enrolment token -----------------------------------------------------------
  app.get('/devices/enrol-token', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const row = (
      await app.db.query(
        `SELECT enrol_token_hash IS NOT NULL AND enrol_token_revoked_at IS NULL AS active,
                enrol_token_label AS label, enrol_token_created_at AS created_at,
                enrol_code_hash IS NOT NULL
                  AND enrol_code_used_at IS NULL
                  AND enrol_code_expires_at > now() AS code_active,
                enrol_code_created_at AS code_created_at,
                enrol_code_expires_at AS code_expires_at
           FROM tenants WHERE id = $1`,
        [ctx.tenantId],
      )
    ).rows[0]
    // Plaintext values are shown exactly once at rotation; here we only report existence.
    return {
      activeToken: row?.active ? { label: row.label, createdAt: row.created_at } : null,
      activeCode: row?.code_active
        ? { createdAt: row.code_created_at, expiresAt: row.code_expires_at }
        : null,
    }
  })

  app.post('/devices/enrol-token/rotate', { preHandler: [...guards, requirePermission('device.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const rotated = await withTenant(app.db, ctx.tenantId, async (client) => {
      const rotated = await rotateEnrolToken(client, ctx.tenantId, request.user!.id)
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'enrol_token.rotated',
        objectType: 'device_enrol_token',
        ip: request.ip,
        payload: {
          tokenHash: rotated.hash.slice(0, 12) + '…',
          codeHash: rotated.codeHash.slice(0, 12) + '…',
          codeExpiresAt: rotated.codeExpiresAt,
        },
      })
      return rotated
    })
    return reply.code(201).send({
      token: rotated.plaintext,
      code: rotated.code,
      codeExpiresAt: rotated.codeExpiresAt,
      note: 'The 12-digit code is shown once, expires in 15 minutes, and is consumed by the first successful enrollment. The opaque token is for protected fleet deployment.',
    })
  })
}
