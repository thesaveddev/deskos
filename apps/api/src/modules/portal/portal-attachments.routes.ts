import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180)
  return base || 'attachment'
}

/**
 * Portal-facing attachment routes.  Authenticated portal users can upload
 * and download files on their *own* tickets — no staff permissions needed.
 */
export async function portalAttachmentRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  // Upload a file to a portal ticket
  app.post('/portal/tickets/:number/attachments', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { number } = request.params as { number: string }
    const maxBytes = app.config.maxUploadBytes

    const ticket = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id FROM tickets WHERE number = $1 AND requester_id = $2',
        [Number(number), request.user!.id],
      )
      return rows[0]
    })
    if (!ticket) throw AppError.notFound('Ticket not found')

    const part = await request.file({ limits: { fileSize: maxBytes } })
    if (!part) throw AppError.badRequest('No file provided', 'missing_file')

    const filename = sanitizeFilename(part.filename ?? 'attachment')
    const { storageKey, sizeBytes: size } = await app.storage.uploadStream('attachments', ctx.tenantId, filename, part.mimetype || 'application/octet-stream', part.file, maxBytes)

    const attachment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO attachments (tenant_id, ticket_id, uploaded_by, filename, mime, size_bytes, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ctx.tenantId, ticket.id, request.user!.id, filename, part.mimetype || 'application/octet-stream', size, storageKey],
      )
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
         VALUES ($1, $2, $3, 'system_event', 'public', $4, $5::jsonb)`,
        [ctx.tenantId, ticket.id, request.user!.id, `Attached ${filename}`, JSON.stringify({ event: 'attachment.added', attachmentId: res.rows[0].id })],
      )
      const row = res.rows[0]
      return { id: row.id, filename: row.filename, mime: row.mime, size_bytes: Number(row.size_bytes), created_at: row.created_at }
    })

    return reply.code(201).send({ attachment })
  })

  // List attachments for a portal ticket
  app.get('/portal/tickets/:number/attachments', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    const { number } = request.params as { number: string }

    return withTenant(app.db, ctx.tenantId, async (client) => {
      const ticket = (await client.query(
        'SELECT id FROM tickets WHERE number = $1 AND requester_id = $2',
        [Number(number), request.user!.id],
      )).rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')

      const { rows } = await client.query(
        `SELECT a.id, a.filename, a.mime, a.size_bytes, a.created_at, u.name AS uploader_name
           FROM attachments a
           LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.ticket_id = $1
          ORDER BY a.created_at ASC`,
        [ticket.id],
      )
      return { attachments: rows.map((r) => ({ ...r, size_bytes: Number(r.size_bytes) })) }
    })
  })

  // Download an attachment (portal user must own the ticket)
  app.get('/portal/attachments/:id', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    const attachment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.* FROM attachments a
          JOIN tickets t ON t.id = a.ticket_id
         WHERE a.id = $1 AND t.requester_id = $2`,
        [id, request.user!.id],
      )
      return rows[0]
    })
    if (!attachment) throw AppError.notFound('Attachment not found')

    const safeName = String(attachment.filename).replace(/["\r\n]/g, '_')
    const stream = await app.storage.downloadStream(attachment.storage_key)
    return reply
      .header('content-type', attachment.mime)
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .send(stream)
  })
}
