import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const roomSchema = z.object({ name: z.string().trim().min(1).max(80) })
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) })
const TEAM_CHAT_ADMIN_ROLES = new Set(['owner', 'it_manager', 'service_desk_manager'])
const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180)
  return base || 'attachment'
}

async function assertRoomAccess(client: import('../../db/pool.js').DbClient, roomId: string, userId: string, orgRole: string) {
  const room = (await client.query('SELECT id, name, team_id FROM chat_rooms WHERE id = $1', [roomId])).rows[0]
  if (!room) throw AppError.notFound('Room not found')
  if (!room.team_id || TEAM_CHAT_ADMIN_ROLES.has(orgRole)) return room
  const member = (await client.query(
    'SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2',
    [room.team_id, userId],
  )).rows[0]
  if (!member) throw AppError.forbidden('You are not a member of this team chat', 'team_chat_membership_required')
  return room
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('chat.read')]
  const write = [authenticate, requireTenant, requirePermission('chat.write')]

  app.get('/chat/rooms', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.name, r.team_id, r.created_at,
                (SELECT count(*) FROM chat_messages m WHERE m.room_id = r.id) AS message_count,
                t.name AS team_name
           FROM chat_rooms r
           LEFT JOIN teams t ON t.id = r.team_id
          WHERE r.team_id IS NULL
             OR $1 IN (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = r.team_id)
             OR $2 IN ('owner', 'it_manager', 'service_desk_manager')
          ORDER BY r.created_at ASC`,
        [request.user!.id, ctx.orgRole],
      )
      return { rooms: rows }
    })
  })

  app.post('/chat/rooms', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = roomSchema.parse(request.body)
    const room = await withTenant(app.db, ctx.tenantId, async (client) => {
      const dup = await client.query('SELECT id FROM chat_rooms WHERE name = $1', [body.name])
      if (dup.rows[0]) throw AppError.conflict('A room with this name already exists', 'duplicate_room')
      const { rows } = await client.query(
        `INSERT INTO chat_rooms (tenant_id, name, created_by)
         VALUES ($1, $2, $3)
         RETURNING id, name, created_at`,
        [ctx.tenantId, body.name, request.user!.id],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'chat.room_created',
        objectType: 'chat_room',
        objectId: rows[0].id,
        ip: request.ip,
        payload: { name: body.name },
      })
      return rows[0]
    })
    return reply.code(201).send({ room })
  })

  app.get('/chat/rooms/:id/messages', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
      const { rows } = await client.query(
        `SELECT m.id, m.body, m.created_at, m.sender_id, u.name AS sender_name,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'id', a.id,
                    'filename', a.filename,
                    'mime', a.mime,
                    'size_bytes', a.size_bytes,
                    'uploaded_by', a.uploaded_by,
                    'created_at', a.created_at
                  ) ORDER BY a.created_at, a.id)
                    FROM chat_attachments a
                   WHERE a.message_id = m.id
                ), '[]'::json) AS attachments
           FROM chat_messages m
           LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.room_id = $1
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT 200`,
        [id],
      )
      return { messages: rows }
    })
  })

  app.get('/chat/attachments/:id', { preHandler: read }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const attachment = await withTenant(app.db, ctx.tenantId, async (client) => {
      const row = (await client.query(
        `SELECT a.*
           FROM chat_attachments a
          WHERE a.id = $1`,
        [id],
      )).rows[0]
      if (!row) throw AppError.notFound('Chat attachment not found')
      await assertRoomAccess(client, row.room_id, request.user!.id, ctx.orgRole)
      return row
    })

    const fullPath = path.join(app.config.uploadDir, attachment.storage_key)
    try {
      await stat(fullPath)
    } catch {
      throw AppError.notFound('Chat attachment file missing from storage')
    }
    const safeName = String(attachment.filename).replace(/["\r\n]/g, '_')
    return reply
      .header('content-type', attachment.mime || 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(fullPath))
  })

  app.post('/chat/rooms/:id/messages', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    let bodyText = ''
    let storedFile: { filename: string; mime: string; sizeBytes: number; storageKey: string; fullPath: string } | null = null

    try {
      if (request.isMultipart()) {
        const parts = request.parts({ limits: { fileSize: CHAT_FILE_MAX_BYTES, files: 1 } })
        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'body') bodyText = String(part.value)
            continue
          }
          if (part.fieldname !== 'file') continue
          const filename = sanitizeFilename(part.filename ?? 'attachment')
          const storageKey = `chat/${ctx.tenantId}/${randomBytes(16).toString('hex')}-${filename}`
          const fullPath = path.join(app.config.uploadDir, storageKey)
          await mkdir(path.dirname(fullPath), { recursive: true })
          await pipeline(part.file, createWriteStream(fullPath))
          if (part.file.truncated) throw AppError.badRequest('File exceeds the 10 MB chat limit', 'file_too_large')
          const fileStat = await stat(fullPath)
          storedFile = { filename, mime: part.mimetype || 'application/octet-stream', sizeBytes: fileStat.size, storageKey, fullPath }
        }
      } else {
        bodyText = String((request.body as { body?: unknown } | undefined)?.body ?? '')
      }

      const body = messageSchema.parse({ body: bodyText.trim() || (storedFile ? `Shared ${storedFile.filename}` : '') })
      const message = await withTenant(app.db, ctx.tenantId, async (client) => {
        const room = await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
        const { rows } = await client.query(
          `INSERT INTO chat_messages (tenant_id, room_id, sender_id, body)
           VALUES ($1, $2, $3, $4)
           RETURNING id, body, created_at, sender_id`,
          [ctx.tenantId, id, request.user!.id, body.body],
        )
        const messageRow = rows[0]
        let attachment = null
        if (storedFile) {
          const result = await client.query(
            `INSERT INTO chat_attachments
               (tenant_id, room_id, message_id, uploaded_by, filename, mime, size_bytes, storage_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id, filename, mime, size_bytes, uploaded_by, created_at`,
            [ctx.tenantId, id, messageRow.id, request.user!.id, storedFile.filename, storedFile.mime, storedFile.sizeBytes, storedFile.storageKey],
          )
          attachment = result.rows[0]
        }

        const sender = (await client.query('SELECT name FROM users WHERE id = $1', [request.user!.id])).rows[0]
        const recipients = await client.query(
          `SELECT DISTINCT m.user_id
             FROM memberships m
             JOIN chat_rooms r ON r.id = $2 AND r.tenant_id = m.tenant_id
             LEFT JOIN team_members tm ON tm.team_id = r.team_id AND tm.user_id = m.user_id
            WHERE m.tenant_id = $1
              AND m.status = 'active'
              AND m.user_id <> $3
              AND (r.team_id IS NULL OR tm.user_id IS NOT NULL OR m.org_role IN ('owner', 'it_manager', 'service_desk_manager'))`,
          [ctx.tenantId, id, request.user!.id],
        )
        const summary = storedFile ? `shared ${storedFile.filename}` : 'sent a new message'
        for (const recipient of recipients.rows) {
          await notify(client, ctx.tenantId, {
            userId: recipient.user_id,
            kind: 'chat.message',
            subjectType: 'chat_room',
            subjectId: id,
            body: `${sender?.name ?? 'A teammate'} ${summary} in #${room.name}.`,
          })
        }
        await recordAudit(client, ctx.tenantId, {
          actorType: 'user',
          actorId: request.user!.id,
          action: storedFile ? 'chat.message_with_attachment_created' : 'chat.message_created',
          objectType: 'chat_message',
          objectId: messageRow.id,
          ip: request.ip,
          payload: storedFile ? { roomId: id, filename: storedFile.filename, sizeBytes: storedFile.sizeBytes } : { roomId: id },
        })
        return { ...messageRow, attachments: attachment ? [attachment] : [] }
      })
      return reply.code(201).send({ message })
    } catch (error) {
      if (storedFile) await unlink(storedFile.fullPath).catch(() => undefined)
      throw error
    }
  })
}
