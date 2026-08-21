import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const LINK_TYPES = ['parent', 'child', 'related', 'caused_by', 'duplicates'] as const
const TARGET_TYPES = ['ticket', 'asset', 'kb', 'session'] as const

const createLinkSchema = z.object({
  linkType: z.enum(LINK_TYPES),
  targetType: z.enum(TARGET_TYPES),
  targetId: z.string().uuid(),
})

/** Verify a polymorphic link target exists within the tenant (RLS-scoped). */
async function targetExists(client: DbClient, targetType: string, targetId: string): Promise<boolean> {
  const table = targetType === 'kb' ? 'kb_articles' : targetType === 'session' ? 'remote_sessions' : `${targetType}s`
  const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [targetId])
  return rows.length > 0
}

export async function ticketLinkRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ticket.read')]
  const write = [authenticate, requireTenant, requirePermission('ticket.write')]

  app.get('/links/search', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as Record<string, string | undefined>
    const type = query.type ?? 'ticket'
    const q = String(query.q ?? '').trim()
    if (q.length < 1) return { results: [] }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      if (type === 'asset') {
        const { rows } = await client.query(
          `SELECT id, name, tag FROM assets WHERE name ILIKE $1 OR tag ILIKE $1 ORDER BY name LIMIT 12`,
          [`%${q}%`],
        )
        return { results: rows.map((row) => ({ id: row.id, type: 'asset', label: `${row.tag} · ${row.name}` })) }
      }
      if (type === 'kb') {
        const { rows } = await client.query(
          `SELECT id, title FROM kb_articles WHERE title ILIKE $1 ORDER BY title LIMIT 12`,
          [`%${q}%`],
        )
        return { results: rows.map((row) => ({ id: row.id, type: 'kb', label: row.title })) }
      }
      const { rows } = await client.query(
        `SELECT id, number, subject FROM tickets WHERE subject ILIKE $1 OR number::text = $2 ORDER BY number DESC LIMIT 12`,
        [`%${q}%`, q.replace(/^#/, '')],
      )
      return { results: rows.map((row) => ({ id: row.id, type: 'ticket', label: `#${row.number} ${row.subject}` })) }
    })
  })

  app.get('/tickets/:id/links', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT l.id, l.link_type, l.target_type, l.target_id, l.created_at,
                t.number AS target_number, t.subject AS target_subject,
                a.name AS target_asset_name,
                kb.title AS target_kb_title
           FROM ticket_links l
           LEFT JOIN tickets t ON l.target_type = 'ticket' AND t.id = l.target_id
           LEFT JOIN assets a ON l.target_type = 'asset' AND a.id = l.target_id
           LEFT JOIN kb_articles kb ON l.target_type = 'kb' AND kb.id = l.target_id
          WHERE l.ticket_id = $1
          ORDER BY l.created_at ASC`,
        [id],
      )
      return { links: rows }
    })
  })

  app.post('/tickets/:id/links', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = createLinkSchema.parse(request.body)
    const link = await withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = (await client.query('SELECT 1 FROM tickets WHERE id = $1', [id])).rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      if (!(await targetExists(client, body.targetType, body.targetId))) {
        throw AppError.badRequest('Link target not found in this tenant', 'target_not_found')
      }
      const res = await client.query(
        `INSERT INTO ticket_links (tenant_id, ticket_id, link_type, target_type, target_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ticket_id, link_type, target_type, target_id) DO NOTHING
         RETURNING id, link_type, target_type, target_id, created_at`,
        [ctx.tenantId, id, body.linkType, body.targetType, body.targetId],
      )
      const row = res.rows[0]
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ticket.linked',
        objectType: 'ticket_link',
        objectId: row?.id ?? id,
        ip: request.ip,
        payload: { ticketId: id, linkType: body.linkType, targetType: body.targetType, targetId: body.targetId },
      })
      return row
    })
    if (!link) return reply.code(200).send({ link: null, duplicate: true })
    return reply.code(201).send({ link })
  })

  app.delete('/links/:linkId', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { linkId } = request.params as { linkId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query('DELETE FROM ticket_links WHERE id = $1 RETURNING id', [linkId])
      if (!res.rows[0]) throw AppError.notFound('Link not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ticket.unlinked',
        objectType: 'ticket_link',
        objectId: linkId,
        ip: request.ip,
      })
      return reply.code(200).send({ ok: true })
    })
  })
}
