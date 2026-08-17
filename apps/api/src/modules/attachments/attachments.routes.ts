import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createWriteStream } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180)
  return base || 'attachment'
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.post('/tickets/:id/attachments', { preHandler: [...guards, requirePermission('ticket.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id: ticketId } = request.params as { id: string }
    const maxBytes = app.config.maxUploadBytes

    const ticketExists = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query('SELECT id FROM tickets WHERE id = $1', [ticketId])
      return rows.length > 0
    })
    if (!ticketExists) throw AppError.notFound('Ticket not found')

    const part = await request.file({ limits: { fileSize: maxBytes } })
    if (!part) throw AppError.badRequest('No file provided', 'missing_file')

    const filename = sanitizeFilename(part.filename ?? 'attachment')
    const storageKey = `${ctx.tenantId}/${randomBytes(16).toString('hex')}-${filename}`
    const fullPath = path.join(app.config.uploadDir, storageKey)
    await mkdir(path.dirname(fullPath), { recursive: true })

    let size = 0
    const counting = async function* () {
      for await (const chunk of part.file) {
        size += chunk.length
        if (size > maxBytes) throw AppError.badRequest('File exceeds the size limit', 'file_too_large')
        yield chunk
      }
    }
    await pipeline(counting(), createWriteStream(fullPath))

    const attachment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO attachments (tenant_id, ticket_id, uploaded_by, filename, mime, size_bytes, storage_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [ctx.tenantId, ticketId, request.user!.id, filename, part.mimetype || 'application/octet-stream', size, storageKey],
      )
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
         VALUES ($1, $2, $3, 'system_event', 'internal', $4, $5::jsonb)`,
        [ctx.tenantId, ticketId, request.user!.id, `Attached ${filename}`, JSON.stringify({ event: 'attachment.added', attachmentId: res.rows[0].id })],
      )
      const row = res.rows[0]
      return { ...row, size_bytes: Number(row.size_bytes) }
    })

    return reply.code(201).send({ attachment })
  })

  app.get('/tickets/:id/attachments', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id: ticketId } = request.params as { id: string }
    const attachments = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, u.name AS uploader_name
           FROM attachments a
           LEFT JOIN users u ON u.id = a.uploaded_by
          WHERE a.ticket_id = $1
          ORDER BY a.created_at ASC`,
        [ticketId],
      )
      return rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) }))
    })
    return { attachments }
  })

  app.get('/attachments/:id', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }

    const attachment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query('SELECT * FROM attachments WHERE id = $1', [id])
      return rows[0]
    })
    if (!attachment) throw AppError.notFound('Attachment not found')

    const fullPath = path.join(app.config.uploadDir, attachment.storage_key)
    try {
      await stat(fullPath)
    } catch {
      throw AppError.notFound('Attachment file missing from storage')
    }

    const safeName = String(attachment.filename).replace(/["\r\n]/g, '_')
    return reply
      .header('content-type', attachment.mime)
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .send(createReadStream(fullPath))
  })
}
