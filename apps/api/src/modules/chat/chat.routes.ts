import path from 'node:path'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { publishChatMessage } from './chat.realtime.js'
import { assertRoomAccess, TEAM_CHAT_ADMIN_ROLES, type ChatRoomRow } from './chat.access.js'
import '../../types.js'

const roomSchema = z.object({ name: z.string().trim().min(1).max(80) })
const roomMemberSchema = z.object({ userId: z.string().uuid() })
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) })
const readMarkerSchema = z.object({ messageId: z.union([z.string(), z.number()]).optional() })
const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024
const MESSAGE_AUTHOR_WINDOW_MS = 60 * 60 * 1000

function sanitizeFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180)
  return base || 'attachment'
}

async function assertRoomManagement(client: import('../../db/pool.js').DbClient, roomId: string, userId: string, orgRole: string): Promise<ChatRoomRow> {
  const room = await assertRoomAccess(client, roomId, userId, orgRole)
  if (TEAM_CHAT_ADMIN_ROLES.has(orgRole) || room.created_by === userId) return room
  throw AppError.forbidden('Only the room creator or an organization manager can manage members', 'chat_room_manage_required')
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('chat.read')]
  const write = [authenticate, requireTenant, requirePermission('chat.write')]

  app.get('/chat/rooms', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.name, r.team_id, r.created_by, r.created_at,
                (SELECT count(*) FROM chat_messages m WHERE m.room_id = r.id) AS message_count,
                (SELECT max(m.created_at) FROM chat_messages m WHERE m.room_id = r.id) AS last_message_at,
                COALESCE((
                  SELECT count(*) FROM chat_messages m
                   WHERE m.room_id = r.id
                     AND m.created_at > COALESCE(cr.last_read_at, '-infinity'::timestamptz)
                ), 0) AS unread_count,
                t.name AS team_name
           FROM chat_rooms r
           LEFT JOIN teams t ON t.id = r.team_id
           LEFT JOIN chat_room_reads cr ON cr.room_id = r.id AND cr.user_id = $1
          WHERE (
            r.team_id IS NULL
            AND (
              NOT EXISTS (SELECT 1 FROM chat_room_members crm WHERE crm.room_id = r.id)
              OR r.created_by = $1
              OR $1 IN (SELECT crm.user_id FROM chat_room_members crm WHERE crm.room_id = r.id)
              OR $2 IN ('owner', 'it_manager', 'service_desk_manager')
            )
          )
             OR ($1 IN (SELECT tm.user_id FROM team_members tm WHERE tm.team_id = r.team_id))
             OR $2 IN ('owner', 'it_manager', 'service_desk_manager')
             OR r.created_by = $1
          ORDER BY COALESCE((SELECT max(m.created_at) FROM chat_messages m WHERE m.room_id = r.id), r.created_at) DESC`,
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
         RETURNING id, name, team_id, created_by, created_at`,
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

  app.get('/chat/rooms/:id/members', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const room = await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
      const explicitCount = Number((await client.query('SELECT count(*)::int AS count FROM chat_room_members WHERE room_id = $1 AND ($2::uuid IS NULL OR user_id <> $2)', [id, room.created_by])).rows[0]?.count ?? 0)
      const result = room.team_id
        ? await client.query(
          `SELECT u.id AS user_id, u.name, u.email, 'team'::text AS source, tm.created_at
             FROM team_members tm JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id = $1 ORDER BY lower(u.name), lower(u.email)`,
          [room.team_id],
        )
        : explicitCount > 0
          ? await client.query(
            `SELECT u.id AS user_id, u.name, u.email, 'direct'::text AS source, crm.created_at
               FROM chat_room_members crm JOIN users u ON u.id = crm.user_id
              WHERE crm.room_id = $1 ORDER BY lower(u.name), lower(u.email)`,
            [id],
          )
          : await client.query(
            `SELECT u.id AS user_id, u.name, u.email, 'organization'::text AS source, m.created_at
               FROM memberships m JOIN users u ON u.id = m.user_id
              WHERE m.tenant_id = $1 AND m.status = 'active'
              ORDER BY lower(u.name), lower(u.email)`,
            [ctx.tenantId],
          )
      return {
        room: { id: room.id, name: room.name, team_id: room.team_id, access_mode: room.team_id ? 'team' : explicitCount > 0 ? 'restricted' : 'organization' },
        members: result.rows,
      }
    })
  })

  app.get('/chat/rooms/:id/member-candidates', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const query = request.query as { q?: string }
    const search = String(query.q ?? '').trim()
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const room = await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
      if (room.team_id) return { members: [] }
      const values: unknown[] = [ctx.tenantId]
      const clauses = ["m.status = 'active'"]
      if (search.length >= 2) {
        values.push(`%${search}%`)
        clauses.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`)
      }
      const result = await client.query(
        `SELECT u.id AS user_id, u.name, u.email, 'organization'::text AS source, m.created_at
           FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND ${clauses.join(' AND ')}
          ORDER BY lower(u.name), lower(u.email)
          LIMIT 25`,
        values,
      )
      return { members: result.rows }
    })
  })

  app.post('/chat/rooms/:id/members', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { userId } = roomMemberSchema.parse(request.body)
    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const room = await assertRoomManagement(client, id, request.user!.id, ctx.orgRole)
      const active = (await client.query("SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'", [ctx.tenantId, userId])).rows[0]
      if (!active) throw AppError.badRequest('The selected person is not an active member of this organization', 'chat_member_invalid')
      if (room.team_id) {
        throw AppError.conflict('Team chat membership is managed from Teams so the roster stays consistent', 'team_chat_membership_managed_by_team')
      } else {
        if ((await client.query('SELECT 1 FROM chat_room_members WHERE room_id = $1 LIMIT 1', [id])).rows.length === 0 && room.created_by) {
          await client.query(
            `INSERT INTO chat_room_members (tenant_id, room_id, user_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (room_id, user_id) DO NOTHING`,
            [ctx.tenantId, id, room.created_by, request.user!.id],
          )
        }
        await client.query(
          `INSERT INTO chat_room_members (tenant_id, room_id, user_id, added_by) VALUES ($1, $2, $3, $4) ON CONFLICT (room_id, user_id) DO NOTHING`,
          [ctx.tenantId, id, userId, request.user!.id],
        )
      }
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'chat.room_member_added', objectType: 'chat_room', objectId: id, ip: request.ip, payload: { userId, teamRoom: Boolean(room.team_id) } })
      return { room, userId }
    })
    return reply.code(201).send(result)
  })

  app.delete('/chat/rooms/:id/members/:userId', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, userId } = request.params as { id: string; userId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const room = await assertRoomManagement(client, id, request.user!.id, ctx.orgRole)
      if (room.team_id) {
        throw AppError.conflict('Team chat membership is managed from Teams so the roster stays consistent', 'team_chat_membership_managed_by_team')
      } else {
        if (room.created_by === userId) throw AppError.conflict('The room creator must remain a member', 'room_creator_member_required')
        const removed = await client.query('DELETE FROM chat_room_members WHERE room_id = $1 AND user_id = $2 RETURNING user_id', [id, userId])
        if (!removed.rows[0]) throw AppError.notFound('Chat room member not found')
      }
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'chat.room_member_removed', objectType: 'chat_room', objectId: id, ip: request.ip, payload: { userId, teamRoom: Boolean(room.team_id) } })
      return { ok: true }
    })
  })

  app.get('/chat/rooms/:id/messages', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
      const { rows } = await client.query(
        `SELECT * FROM (
          SELECT m.id, m.body, m.created_at, m.edited_at, m.sender_id, u.name AS sender_name,
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
           ORDER BY m.created_at DESC, m.id DESC
           LIMIT 200
        ) latest
        ORDER BY latest.created_at ASC, latest.id ASC`,
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

    const safeName = String(attachment.filename).replace(/["\r\n]/g, '_')
    const stream = await app.storage.downloadStream(attachment.storage_key)
    return reply
      .header('content-type', attachment.mime || 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${safeName}"`)
      .header('x-content-type-options', 'nosniff')
      .send(stream)
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
          const { storageKey, sizeBytes } = await app.storage.uploadStream('chat', ctx.tenantId, filename, part.mimetype || 'application/octet-stream', part.file, CHAT_FILE_MAX_BYTES)
          storedFile = { filename, mime: part.mimetype || 'application/octet-stream', sizeBytes, storageKey, fullPath: '' }
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
              AND (
               (r.team_id IS NOT NULL AND (tm.user_id IS NOT NULL OR m.org_role IN ('owner', 'it_manager', 'service_desk_manager') OR r.created_by = m.user_id))
               OR (r.team_id IS NULL AND (
                 NOT EXISTS (SELECT 1 FROM chat_room_members crm WHERE crm.room_id = r.id AND crm.user_id <> r.created_by)
                 OR r.created_by = m.user_id
                 OR m.user_id IN (SELECT crm.user_id FROM chat_room_members crm WHERE crm.room_id = r.id)
                 OR m.org_role IN ('owner', 'it_manager', 'service_desk_manager')
               ))
             )`,
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
      await publishChatMessage(app.db, ctx.tenantId, id, message)
      return reply.code(201).send({ message })
    } catch (error) {
      if (storedFile?.storageKey) await app.storage.delete(storedFile.storageKey)
      throw error
    }
  })

  app.delete('/chat/messages/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const row = (await client.query(
        `SELECT m.id, m.room_id, m.sender_id, m.created_at
           FROM chat_messages m
          WHERE m.id = $1`,
        [id],
      )).rows[0] as { id: string; room_id: string; sender_id: string | null; created_at: string } | undefined
      if (!row) throw AppError.notFound('Message not found')
      await assertRoomAccess(client, row.room_id, request.user!.id, ctx.orgRole)
      const isModerator = TEAM_CHAT_ADMIN_ROLES.has(ctx.orgRole) || (await isRoomCreator(client, row.room_id, request.user!.id))
      const isAuthor = row.sender_id === request.user!.id
      const withinWindow = Date.now() - new Date(row.created_at).getTime() <= MESSAGE_AUTHOR_WINDOW_MS
      if ((!isAuthor || !withinWindow) && !isModerator) {
        throw AppError.forbidden('Messages can only be deleted by their author within an hour, or by a manager at any time', 'chat_message_delete_forbidden')
      }
      await client.query('DELETE FROM chat_messages WHERE id = $1', [id])
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'chat.message_deleted',
        objectType: 'chat_message',
        objectId: id,
        ip: request.ip,
        payload: { roomId: row.room_id, author: row.sender_id },
      })
      return { ok: true }
    })
  })

  app.patch('/chat/messages/:id', { preHandler: write }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = messageSchema.parse(request.body)
    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const row = (await client.query(
        `SELECT m.id, m.room_id, m.sender_id, m.created_at
           FROM chat_messages m
          WHERE m.id = $1`,
        [id],
      )).rows[0] as { id: string; room_id: string; sender_id: string | null; created_at: string } | undefined
      if (!row) throw AppError.notFound('Message not found')
      await assertRoomAccess(client, row.room_id, request.user!.id, ctx.orgRole)
      // Editing rewrites someone's words, so it stays author-only even for
      // managers — moderation of other people's messages is delete-only.
      const isAuthor = row.sender_id === request.user!.id
      const withinWindow = Date.now() - new Date(row.created_at).getTime() <= MESSAGE_AUTHOR_WINDOW_MS
      if (!isAuthor || !withinWindow) {
        throw AppError.forbidden('Messages can only be edited by their author within an hour', 'chat_message_edit_forbidden')
      }
      const updated = (await client.query(
        `UPDATE chat_messages SET body = $2, edited_at = now()
          WHERE id = $1
          RETURNING id, body, created_at, edited_at, sender_id`,
        [id, body.body],
      )).rows[0]
      const sender = (await client.query('SELECT name FROM users WHERE id = $1', [request.user!.id])).rows[0]
      const attachments = (await client.query(
        `SELECT id, filename, mime, size_bytes, uploaded_by, created_at
           FROM chat_attachments WHERE message_id = $1 ORDER BY created_at, id`,
        [id],
      )).rows
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'chat.message_edited',
        objectType: 'chat_message',
        objectId: id,
        ip: request.ip,
        payload: { roomId: row.room_id },
      })
      return { roomId: row.room_id, message: { ...updated, sender_name: sender?.name ?? null, attachments } }
    })
    // Let every open socket in the room see the edit without a reload.
    await publishChatMessage(app.db, ctx.tenantId, result.roomId, result.message, 'chat.message.updated')
    return { message: result.message }
  })

  app.post('/chat/rooms/:id/read', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const marker = readMarkerSchema.parse(request.body ?? {})
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await assertRoomAccess(client, id, request.user!.id, ctx.orgRole)
      await client.query(
        `INSERT INTO chat_room_reads (tenant_id, room_id, user_id, last_read_at, last_read_message_id)
         VALUES ($1, $2, $3, now(), $4)
         ON CONFLICT (room_id, user_id)
         DO UPDATE SET last_read_at = now(), last_read_message_id = EXCLUDED.last_read_message_id, updated_at = now()`,
        [ctx.tenantId, id, request.user!.id, marker.messageId ?? null],
      )
    })
    return { ok: true }
  })
}

function isRoomCreator(client: import('../../db/pool.js').DbClient, roomId: string, userId: string): Promise<boolean> {
  return client.query('SELECT 1 FROM chat_rooms WHERE id = $1 AND created_by = $2', [roomId, userId]).then((r) => r.rows.length > 0)
}
