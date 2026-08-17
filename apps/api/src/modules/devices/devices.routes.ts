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

const OFFLINE_SQL = (secs: number) =>
  `CASE
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
  const offlineSec = app.config.deviceOfflineSec

  // -- Devices ---------------------------------------------------------------
  app.get('/devices', { preHandler: [...guards, requirePermission('device.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { q?: string; groupId?: string; status?: string; limit?: string; offset?: string; cursor?: string }
    const clauses: string[] = []
    const values: unknown[] = []
    if (q.q) {
      values.push(`%${q.q}%`)
      clauses.push(`(d.name ILIKE $${values.length} OR d.hostname ILIKE $${values.length} OR d.os ILIKE $${values.length})`)
    }
    if (q.groupId && isUuid(q.groupId)) {
      values.push(q.groupId)
      clauses.push(`d.group_id = $${values.length}`)
    }
    const statusExpr = OFFLINE_SQL(offlineSec)
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
                  d.agent_version, d.group_id, d.enrolled_at, d.last_seen_at, d.created_at,
                  g.name AS group_name,
                  ${statusExpr} AS status
             FROM devices d
             LEFT JOIN device_groups g ON g.id = d.group_id
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
      const statusExpr = OFFLINE_SQL(offlineSec)
      const device = (
        await client.query(
          `SELECT d.id, d.tenant_id, d.group_id, d.name, d.hostname, d.os, d.os_version,
                  d.arch, d.ip_address, d.agent_version, NULL::text AS agent_token_hash,
                  d.enrolled_at, d.last_seen_at, d.created_at, d.updated_at,
                  g.name AS group_name,
                  ${statusExpr} AS status
             FROM devices d
             LEFT JOIN device_groups g ON g.id = d.group_id
            WHERE d.id = $1`,
          [id],
        )
      ).rows[0]
      if (!device) throw AppError.notFound('Device not found')

      const metrics = (
        await client.query(
          `SELECT id, cpu_pct, mem_pct, disk_pct, recorded_at
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
      return { device, metrics: metrics.reverse(), alerts, tickets }
    })
  })

  app.patch('/devices/:id', { preHandler: [...guards, requirePermission('device.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = devicePatchSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM devices WHERE id = $1', [id])).rows[0]
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
      const current = (await client.query('SELECT id FROM devices WHERE id = $1', [id])).rows[0]
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
             LEFT JOIN devices d ON d.group_id = g.id
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
            ${openOnly ? 'WHERE a.resolved_at IS NULL' : ''}
            ORDER BY a.created_at DESC
            LIMIT 100`,
        )
        .then((r) => r.rows),
    )
    return { alerts: rows }
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
      note: 'The eight-digit code is shown once, expires in 15 minutes, and is consumed by the first successful enrollment. The opaque token is for protected fleet deployment.',
    })
  })
}
