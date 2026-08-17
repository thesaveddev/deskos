import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const roomSchema = z.object({ name: z.string().trim().min(1).max(80) })
const messageSchema = z.object({ body: z.string().trim().min(1).max(4000) })

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('chat.read')]
  const write = [authenticate, requireTenant, requirePermission('chat.write')]

  app.get('/chat/rooms', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.name, r.created_at,
                (SELECT count(*) FROM chat_messages m WHERE m.room_id = r.id) AS message_count
           FROM chat_rooms r
          ORDER BY r.created_at ASC`,
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
      const room = (await client.query('SELECT id FROM chat_rooms WHERE id = $1', [id])).rows[0]
      if (!room) throw AppError.notFound('Room not found')
      const { rows } = await client.query(
        `SELECT m.id, m.body, m.created_at, m.sender_id, u.name AS sender_name
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

  app.post('/chat/rooms/:id/messages', { preHandler: write }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = messageSchema.parse(request.body)
    const message = await withTenant(app.db, ctx.tenantId, async (client) => {
      const room = (await client.query('SELECT id FROM chat_rooms WHERE id = $1', [id])).rows[0]
      if (!room) throw AppError.notFound('Room not found')
      const { rows } = await client.query(
        `INSERT INTO chat_messages (tenant_id, room_id, sender_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, body, created_at, sender_id`,
        [ctx.tenantId, id, request.user!.id, body.body],
      )
      return rows[0]
    })
    return reply.code(201).send({ message })
  })
}
