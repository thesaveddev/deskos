import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const ASSET_TYPES = ['hardware', 'mobile', 'network', 'peripheral', 'cloud', 'software', 'other'] as const
const ASSET_STATUSES = ['in_use', 'available', 'in_repair', 'retired', 'lost'] as const

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

const assetCreateSchema = z.object({
  tag: z.string().trim().min(1).max(80),
  type: z.enum(ASSET_TYPES),
  name: z.string().trim().min(1).max(200),
  status: z.enum(ASSET_STATUSES).default('in_use'),
  ownerId: z.string().uuid().optional(),
  location: z.string().trim().max(200).optional(),
  supplier: z.string().trim().max(120).optional(),
  warrantyUntil: dateString.optional(),
  purchase: z.record(z.unknown()).default({}),
  deviceId: z.string().uuid().optional(),
  ext: z.record(z.unknown()).default({}),
})

const assetUpdateSchema = z.object({
  tag: z.string().trim().min(1).max(80).optional(),
  type: z.enum(ASSET_TYPES).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(ASSET_STATUSES).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  supplier: z.string().trim().max(120).nullable().optional(),
  warrantyUntil: dateString.nullable().optional(),
  purchase: z.record(z.unknown()).optional(),
  deviceId: z.string().uuid().nullable().optional(),
  ext: z.record(z.unknown()).optional(),
})

const licenceCreateSchema = z.object({
  assetId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  keyRef: z.string().trim().max(500).default(''),
  seatsUsed: z.number().int().min(0).default(0),
  seatsTotal: z.number().int().min(0).default(0),
  expiresAt: dateString.optional(),
})

const licenceUpdateSchema = z.object({
  assetId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  keyRef: z.string().trim().max(500).optional(),
  seatsUsed: z.number().int().min(0).optional(),
  seatsTotal: z.number().int().min(0).optional(),
  expiresAt: dateString.nullable().optional(),
})

const licenceAssignmentSchema = z.object({
  userId: z.string().uuid(),
  seats: z.number().int().min(1).max(10_000).default(1),
  reason: z.string().trim().max(500).default(''),
  notes: z.string().trim().max(5_000).default(''),
})

/** Confirm a deviceId belongs to the current tenant (RLS-scoped lookup). */
async function ensureDeviceInTenant(client: DbClient, tenantId: string, deviceId: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM devices WHERE id = $1 AND tenant_id = $2', [deviceId, tenantId])
  if (!rows[0]) throw AppError.badRequest('Device not found in this tenant', 'device_not_found')
}

async function ensureOwnerInTenant(client: DbClient, tenantId: string, ownerId: string): Promise<void> {
  const { rows } = await client.query(
    'SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3',
    [tenantId, ownerId, 'active'],
  )
  if (!rows[0]) throw AppError.badRequest('Owner is not a member of this tenant', 'owner_not_member')
}

async function ensureAssetInTenant(client: DbClient, tenantId: string, assetId: string): Promise<void> {
  const { rows } = await client.query('SELECT 1 FROM assets WHERE id = $1 AND tenant_id = $2', [assetId, tenantId])
  if (!rows[0]) throw AppError.badRequest('Asset not found in this tenant', 'asset_not_found')
}

export async function assetRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('asset.read')]
  const write = [authenticate, requireTenant, requirePermission('asset.manage')]

  // ---- Assets -------------------------------------------------------------
  app.get('/assets', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { q?: string; type?: string; status?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      if (query.type && (ASSET_TYPES as readonly string[]).includes(query.type)) {
        values.push(query.type)
        clauses.push(`type = $${values.length}`)
      }
      if (query.status && (ASSET_STATUSES as readonly string[]).includes(query.status)) {
        values.push(query.status)
        clauses.push(`status = $${values.length}`)
      }
      if (query.q) {
        values.push(`%${query.q}%`)
        clauses.push(`(a.name ILIKE $${values.length} OR a.tag ILIKE $${values.length})`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const res = await client.query(
        `SELECT a.*, u.name AS owner_name, d.name AS device_name,
                da.assignment_status, au.name AS assigned_user_name,
                da.department AS assigned_department, da.location AS assigned_location
           FROM assets a
           LEFT JOIN users u ON u.id = a.owner_id
           LEFT JOIN devices d ON d.id = a.device_id
           LEFT JOIN device_assignments da ON da.device_id = a.device_id AND da.ended_at IS NULL
           LEFT JOIN users au ON au.id = da.user_id
           ${where}
          ORDER BY a.name ASC LIMIT 200`,
        values,
      )
      return { assets: res.rows }
    })
  })

  app.get('/assets/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, u.name AS owner_name, d.name AS device_name,
                da.assignment_status, au.name AS assigned_user_name,
                da.department AS assigned_department, da.location AS assigned_location
           FROM assets a
           LEFT JOIN users u ON u.id = a.owner_id
           LEFT JOIN devices d ON d.id = a.device_id
           LEFT JOIN device_assignments da ON da.device_id = a.device_id AND da.ended_at IS NULL
           LEFT JOIN users au ON au.id = da.user_id
          WHERE a.id = $1`,
        [id],
      )
      if (!rows[0]) throw AppError.notFound('Asset not found')
      const licences = await client.query(
        `SELECT * FROM licences WHERE asset_id = $1 ORDER BY name ASC`,
        [id],
      )
      return { asset: rows[0], licences: licences.rows }
    })
  })

  app.post('/assets', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = assetCreateSchema.parse(request.body)
    const asset = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.deviceId) await ensureDeviceInTenant(client, ctx.tenantId, body.deviceId)
      if (body.ownerId) await ensureOwnerInTenant(client, ctx.tenantId, body.ownerId)

      const dup = await client.query('SELECT 1 FROM assets WHERE tag = $1', [body.tag])
      if (dup.rows[0]) throw AppError.conflict('Asset tag already exists')

      const res = await client.query(
        `INSERT INTO assets (tenant_id, tag, type, name, status, owner_id, location, supplier, warranty_until, purchase, device_id, ext, qr_payload, barcode_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13, $14)
         RETURNING *`,
        [
          ctx.tenantId, body.tag, body.type, body.name, body.status, body.ownerId ?? null,
          body.location ?? null, body.supplier ?? null, body.warrantyUntil ?? null,
          JSON.stringify(body.purchase), body.deviceId ?? null, JSON.stringify(body.ext),
          `reydesk://asset/${ctx.tenantId}/${body.tag}`, body.tag,
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'asset.created',
        objectType: 'asset',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { tag: body.tag, type: body.type },
      })
      return res.rows[0]
    })
    return reply.code(201).send({ asset })
  })

  app.patch('/assets/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = assetUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM assets WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Asset not found')

      if (body.deviceId) await ensureDeviceInTenant(client, ctx.tenantId, body.deviceId)
      if (body.ownerId) await ensureOwnerInTenant(client, ctx.tenantId, body.ownerId)
      if (body.tag && body.tag !== current.tag) {
        throw AppError.badRequest('Asset tags are immutable after creation. Create a new asset record if the label was entered incorrectly.', 'asset_tag_immutable')
      }

      const res = await client.query(
        `UPDATE assets SET
           tag = $2, type = $3, name = $4, status = $5, owner_id = $6, location = $7,
           supplier = $8, warranty_until = $9, purchase = $10::jsonb, device_id = $11, ext = $12::jsonb,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          body.tag ?? current.tag,
          body.type ?? current.type,
          body.name ?? current.name,
          body.status ?? current.status,
          body.ownerId === undefined ? current.owner_id : body.ownerId,
          body.location === undefined ? current.location : body.location,
          body.supplier === undefined ? current.supplier : body.supplier,
          body.warrantyUntil === undefined ? current.warranty_until : body.warrantyUntil,
          JSON.stringify(body.purchase ?? current.purchase),
          body.deviceId === undefined ? current.device_id : body.deviceId,
          JSON.stringify(body.ext ?? current.ext),
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'asset.updated',
        objectType: 'asset',
        objectId: id,
        ip: request.ip,
      })
      return { asset: res.rows[0] }
    })
  })

  app.delete('/assets/:id', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM assets WHERE id = $1 RETURNING id', [id])
      if (!res.rows[0]) throw AppError.notFound('Asset not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'asset.deleted',
        objectType: 'asset',
        objectId: id,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })

  // ---- Licences -----------------------------------------------------------
  app.get('/licences', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { assetId } = request.query as { assetId?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = assetId
        ? await client.query('SELECT * FROM licences WHERE asset_id = $1 ORDER BY name ASC', [assetId])
        : await client.query('SELECT * FROM licences ORDER BY expires_at ASC NULLS LAST, name ASC LIMIT 200')
      return { licences: res.rows }
    })
  })

  app.get('/licences/:id/assignments', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const licence = (await client.query('SELECT id FROM licences WHERE id = $1', [id])).rows[0]
      if (!licence) throw AppError.notFound('Licence not found')
      const result = await client.query(
        `SELECT la.*, u.name AS user_name, u.email AS user_email, ab.name AS assigned_by_name
           FROM licence_assignments la
           JOIN users u ON u.id = la.user_id
           LEFT JOIN users ab ON ab.id = la.assigned_by
          WHERE la.licence_id = $1 ORDER BY la.assigned_at DESC`,
        [id],
      )
      return { assignments: result.rows }
    })
  })

  app.post('/licences/:id/assignments', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = licenceAssignmentSchema.parse(request.body)
    const assignment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const licence = (await client.query('SELECT id, seats_total, seats_used FROM licences WHERE id = $1', [id])).rows[0]
      if (!licence) throw AppError.notFound('Licence not found')
      const member = (await client.query("SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'", [ctx.tenantId, body.userId])).rows[0]
      if (!member) throw AppError.badRequest('The selected staff member is not active in this organization', 'licence_user_invalid')
      const used = (await client.query('SELECT COALESCE(sum(seats), 0)::int AS seats FROM licence_assignments WHERE licence_id = $1 AND ended_at IS NULL', [id])).rows[0].seats
      if (Number(licence.seats_total) > 0 && Number(used) + body.seats > Number(licence.seats_total)) throw AppError.conflict('There are not enough licence seats available', 'licence_seats_exhausted')
      const result = await client.query(
        `INSERT INTO licence_assignments (tenant_id, licence_id, user_id, assigned_by, seats, reason, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ctx.tenantId, id, body.userId, request.user!.id, body.seats, body.reason, body.notes],
      )
      await client.query('UPDATE licences SET seats_used = (SELECT COALESCE(sum(seats), 0) FROM licence_assignments WHERE licence_id = $1 AND ended_at IS NULL), updated_at = now() WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'licence.assignment.created', objectType: 'licence_assignment', objectId: result.rows[0].id, ip: request.ip, payload: { licenceId: id, userId: body.userId, seats: body.seats } })
      return result.rows[0]
    })
    return reply.code(201).send({ assignment })
  })

  app.post('/licences/:id/assignments/:assignmentId/return', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, assignmentId } = request.params as { id: string; assignmentId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query("UPDATE licence_assignments SET ended_at = now() WHERE id = $1 AND licence_id = $2 AND ended_at IS NULL RETURNING *", [assignmentId, id])
      if (!result.rows[0]) throw AppError.notFound('Active licence assignment not found')
      await client.query('UPDATE licences SET seats_used = (SELECT COALESCE(sum(seats), 0) FROM licence_assignments WHERE licence_id = $1 AND ended_at IS NULL), updated_at = now() WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'licence.assignment.returned', objectType: 'licence_assignment', objectId: assignmentId, ip: request.ip })
      return { assignment: result.rows[0] }
    })
  })

  app.post('/licences', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = licenceCreateSchema.parse(request.body)
    const licence = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.assetId) await ensureAssetInTenant(client, ctx.tenantId, body.assetId)
      const res = await client.query(
        `INSERT INTO licences (tenant_id, asset_id, name, key_ref, seats_used, seats_total, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ctx.tenantId, body.assetId ?? null, body.name, body.keyRef, body.seatsUsed, body.seatsTotal, body.expiresAt ?? null],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'licence.created',
        objectType: 'licence',
        objectId: res.rows[0].id,
        ip: request.ip,
      })
      return res.rows[0]
    })
    return reply.code(201).send({ licence })
  })

  app.patch('/licences/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = licenceUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM licences WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Licence not found')
      if (body.assetId) await ensureAssetInTenant(client, ctx.tenantId, body.assetId)

      const res = await client.query(
        `UPDATE licences SET
           asset_id = $2, name = $3, key_ref = $4, seats_used = $5, seats_total = $6, expires_at = $7,
           updated_at = now()
         WHERE id = $1 RETURNING *`,
        [
          id,
          body.assetId === undefined ? current.asset_id : body.assetId,
          body.name ?? current.name,
          body.keyRef ?? current.key_ref,
          body.seatsUsed ?? current.seats_used,
          body.seatsTotal ?? current.seats_total,
          body.expiresAt === undefined ? current.expires_at : body.expiresAt,
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'licence.updated',
        objectType: 'licence',
        objectId: id,
        ip: request.ip,
      })
      return { licence: res.rows[0] }
    })
  })

  app.delete('/licences/:id', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM licences WHERE id = $1 RETURNING id', [id])
      if (!res.rows[0]) throw AppError.notFound('Licence not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'licence.deleted',
        objectType: 'licence',
        objectId: id,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })
}
