import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const createSchema = z.object({
  name: z.string().min(1).max(200),
  shortcut: z
    .string()
    .min(1)
    .max(40)
    .transform((s) => s.trim())
    .refine((s) => /^[a-zA-Z0-9._-]+$/.test(s), { message: 'shortcut may only contain letters, numbers, dots, dashes and underscores' }),
  body: z.string().min(1).max(20_000),
})

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  shortcut: z
    .string()
    .min(1)
    .max(40)
    .transform((s) => s.trim())
    .refine((s) => /^[a-zA-Z0-9._-]+$/.test(s), { message: 'shortcut may only contain letters, numbers, dots, dashes and underscores' })
    .optional(),
  body: z.string().min(1).max(20_000).optional(),
})

/**
 * Canned (predefined) responses: reusable reply/note templates for technicians.
 * Readable by anyone with `canned.read`, managed by `canned.manage`.
 */
export async function cannedRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant] as const

  app.get('/canned-responses', { preHandler: [...guards, requirePermission('canned.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const q = request.query as { q?: string }
    const rows = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT id, name, shortcut, body, created_by, created_at, updated_at
             FROM canned_responses
            WHERE $1::text = '' OR name ILIKE $1 OR shortcut ILIKE $1 OR body ILIKE $1
            ORDER BY lower(name) ASC`,
          [q.q ? `%${q.q}%` : ''],
        )
        .then((r) => r.rows),
    )
    return { cannedResponses: rows }
  })

  app.post('/canned-responses', { preHandler: [...guards, requirePermission('canned.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)

    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      try {
        const res = await client.query(
          `INSERT INTO canned_responses (tenant_id, name, shortcut, body, created_by)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [ctx.tenantId, body.name, body.shortcut, body.body, request.user!.id],
        )
        await recordAudit(client, ctx.tenantId, {
          actorId: request.user!.id,
          action: 'canned_response.created',
          objectType: 'canned_response',
          objectId: res.rows[0].id,
          ip: request.ip,
          payload: { name: body.name, shortcut: body.shortcut },
        })
        return res.rows[0]
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw AppError.conflict('A canned response with this shortcut already exists', 'shortcut_exists')
        }
        throw err
      }
    })
    return reply.code(201).send({ cannedResponse: created })
  })

  app.patch('/canned-responses/:id', { preHandler: [...guards, requirePermission('canned.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM canned_responses WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Canned response not found')

      const sets: string[] = []
      const values: unknown[] = []
      for (const field of ['name', 'shortcut', 'body'] as const) {
        const value = body[field]
        if (value === undefined) continue
        values.push(value)
        sets.push(`${field} = $${values.length}`)
      }
      if (sets.length === 0) throw AppError.badRequest('Nothing to update')
      values.push(id)
      try {
        const res = await client.query(
          `UPDATE canned_responses SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
          values,
        )
        await recordAudit(client, ctx.tenantId, {
          actorId: request.user!.id,
          action: 'canned_response.updated',
          objectType: 'canned_response',
          objectId: id,
          ip: request.ip,
          payload: { changes: body },
        })
        return { cannedResponse: res.rows[0] }
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw AppError.conflict('A canned response with this shortcut already exists', 'shortcut_exists')
        }
        throw err
      }
    })
  })

  app.delete('/canned-responses/:id', { preHandler: [...guards, requirePermission('canned.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT id FROM canned_responses WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Canned response not found')
      await client.query('DELETE FROM canned_responses WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'canned_response.deleted',
        objectType: 'canned_response',
        objectId: id,
        ip: request.ip,
      })
      return { ok: true }
    })
  })
}
