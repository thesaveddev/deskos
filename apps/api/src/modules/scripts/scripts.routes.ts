import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { roleHasPermission } from '../../core/permissions.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const APPROVAL_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const
const PRIVILEGE_LEVELS = ['user', 'elevated'] as const

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(60).default('general'),
  os: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  body: z.string().max(100_000).default(''),
  argsSchema: z.array(z.record(z.unknown())).max(50).default([]),
  privilegeLevel: z.enum(PRIVILEGE_LEVELS).default('user'),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(60).optional(),
  os: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  body: z.string().max(100_000).optional(),
  argsSchema: z.array(z.record(z.unknown())).max(50).optional(),
  privilegeLevel: z.enum(PRIVILEGE_LEVELS).optional(),
})

const runSchema = z.object({
  deviceId: z.string().uuid().optional(),
  args: z.record(z.unknown()).default({}),
})

export async function scriptRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('script.read')]
  const manage = [authenticate, requireTenant, requirePermission('script.manage')]
  const execute = [authenticate, requireTenant, requirePermission('script.execute')]

  app.get('/scripts', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { category, status, q } = request.query as { category?: string; status?: string; q?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      if (category) { values.push(category); clauses.push(`category = $${values.length}`) }
      if (status && (APPROVAL_STATUSES as readonly string[]).includes(status)) { values.push(status); clauses.push(`approval_status = $${values.length}`) }
      if (q) { values.push(`%${q}%`); clauses.push(`(name ILIKE $${values.length} OR category ILIKE $${values.length})`) }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const res = await client.query(
        `SELECT s.*, u.name AS author_name
           FROM scripts s
           LEFT JOIN users u ON u.id = s.created_by
           ${where}
          ORDER BY s.name ASC LIMIT 200`,
        values,
      )
      return { scripts: res.rows }
    })
  })

  app.post('/scripts', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const script = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO scripts (tenant_id, name, category, os, version, approval_status, body, args_schema, privilege_level, created_by)
         VALUES ($1, $2, $3, $4, 1, 'draft', $5, $6::jsonb, $7, $8) RETURNING *`,
        [ctx.tenantId, body.name, body.category, body.os, body.body, JSON.stringify(body.argsSchema), body.privilegeLevel, request.user!.id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.created',
        objectType: 'script',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { name: body.name },
      })
      return res.rows[0]
    })
    return reply.code(201).send({ script })
  })

  app.get('/scripts/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT s.*, u.name AS author_name, a.name AS approver_name
           FROM scripts s
           LEFT JOIN users u ON u.id = s.created_by
           LEFT JOIN users a ON a.id = s.approved_by
          WHERE s.id = $1`,
        [id],
      )
      if (!rows[0]) throw AppError.notFound('Script not found')
      return { script: rows[0] }
    })
  })

  app.patch('/scripts/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM scripts WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Script not found')

      const bodyChanged = body.body !== undefined && body.body !== current.body
      const version = bodyChanged ? current.version + 1 : current.version
      // A body change resets approval: the new version must be re-approved.
      const approvalStatus = bodyChanged ? 'draft' : current.approval_status

      const res = await client.query(
        `UPDATE scripts SET
           name = $2, category = $3, os = $4, body = $5, args_schema = $6::jsonb,
           privilege_level = $7, version = $8, approval_status = $9, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          body.name ?? current.name,
          body.category ?? current.category,
          body.os ?? current.os,
          body.body ?? current.body,
          JSON.stringify(body.argsSchema ?? current.args_schema),
          body.privilegeLevel ?? current.privilege_level,
          version,
          approvalStatus,
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.updated',
        objectType: 'script',
        objectId: id,
        ip: request.ip,
        payload: { version },
      })
      return { script: res.rows[0] }
    })
  })

  app.post('/scripts/:id/submit', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM scripts WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Script not found')
      if (current.approval_status !== 'draft' && current.approval_status !== 'rejected') {
        throw AppError.badRequest('Only draft or rejected scripts can be submitted', 'invalid_state')
      }
      const res = await client.query(
        `UPDATE scripts SET approval_status = 'pending', updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.submitted',
        objectType: 'script',
        objectId: id,
        ip: request.ip,
      })
      return { script: res.rows[0] }
    })
  })

  app.post('/scripts/:id/approve', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM scripts WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Script not found')
      if (current.approval_status !== 'pending') throw AppError.badRequest('Only pending scripts can be approved', 'invalid_state')
      const res = await client.query(
        `UPDATE scripts SET approval_status = 'approved', approved_by = $2, approved_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, request.user!.id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.approved',
        objectType: 'script',
        objectId: id,
        ip: request.ip,
      })
      return { script: res.rows[0] }
    })
  })

  app.post('/scripts/:id/reject', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM scripts WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Script not found')
      if (current.approval_status !== 'pending') throw AppError.badRequest('Only pending scripts can be rejected', 'invalid_state')
      const res = await client.query(
        `UPDATE scripts SET approval_status = 'rejected', updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.rejected',
        objectType: 'script',
        objectId: id,
        ip: request.ip,
      })
      return { script: res.rows[0] }
    })
  })

  app.delete('/scripts/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM scripts WHERE id = $1 RETURNING id', [id])
      if (!res.rows[0]) throw AppError.notFound('Script not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.deleted',
        objectType: 'script',
        objectId: id,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })

  // ---- Execution records ---------------------------------------------------
  app.post('/scripts/:id/run', { preHandler: execute }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = runSchema.parse(request.body)
    const run = await withTenant(app.db, ctx.tenantId, async (client) => {
      const script = (await client.query('SELECT * FROM scripts WHERE id = $1', [id])).rows[0]
      if (!script) throw AppError.notFound('Script not found')
      if (script.approval_status !== 'approved') throw AppError.badRequest('Script is not approved', 'script_not_approved')
      if (script.privilege_level === 'elevated' && !roleHasPermission(ctx.orgRole, 'remote.elevated')) {
        throw AppError.forbidden('Elevated scripts require remote.elevated', 'missing_permission')
      }
      if (body.deviceId) {
        const dev = await client.query('SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2', [body.deviceId, ctx.tenantId])
        if (!dev.rows[0]) throw AppError.badRequest('Device not found in this tenant', 'device_not_found')
      }
      const res = await client.query(
        `INSERT INTO script_runs (tenant_id, script_id, device_id, actor_id, args, started_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, now()) RETURNING *`,
        [ctx.tenantId, id, body.deviceId ?? null, request.user!.id, JSON.stringify(body.args)],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'script.run',
        objectType: 'script_run',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { scriptId: id },
      })
      return res.rows[0]
    })
    return reply.code(201).send({ run })
  })

  app.get('/scripts/:id/runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT r.*, u.name AS actor_name
           FROM script_runs r
           LEFT JOIN users u ON u.id = r.actor_id
          WHERE r.script_id = $1 ORDER BY r.started_at DESC LIMIT 100`,
        [id],
      )
      return { runs: res.rows }
    })
  })

  app.get('/script-runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT r.*, s.name AS script_name, u.name AS actor_name
           FROM script_runs r
           JOIN scripts s ON s.id = r.script_id
           LEFT JOIN users u ON u.id = r.actor_id
          ORDER BY r.started_at DESC LIMIT 100`,
      )
      return { runs: res.rows }
    })
  })
}
