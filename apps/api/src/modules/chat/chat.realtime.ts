import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { verifyAccessToken } from '../../core/auth/jwt.js'
import { roleHasAll, type OrgRole } from '../../core/permissions.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { assertRoomAccess } from './chat.access.js'
import '../../types.js'

const CHAT_CHANNEL = 'reydesk_chat'
const HEARTBEAT_INTERVAL_MS = 25_000

type ChatSubscriber = {
  roomId: string
  userId: string
  tenantId: string
  alive: boolean
  send: (data: string) => void
  ping: () => void
  isAlive: () => boolean
}

const subscribers = new Map<string, ChatSubscriber>()

function chatKey(tenantId: string, roomId: string, userId: string): string {
  return `${tenantId}:${roomId}:${userId}`
}

type BroadcastMessage = {
  id: string | number
  body: string
  created_at: string
  sender_id: string | null
  sender_name?: string | null
  attachments?: unknown[]
}

/**
 * Single broadcast path: every published message goes through Postgres
 * NOTIFY once, and each instance's LISTEN connection fans out to its local
 * subscribers exactly once. This avoids the double-delivery of the previous
 * local-loop-plus-NOTIFY approach and keeps multi-instance deploys correct.
 */
export async function publishChatMessage(pool: DbPool, tenantId: string, roomId: string, message: BroadcastMessage): Promise<void> {
  await pool
    .query('SELECT pg_notify($1, $2)', [CHAT_CHANNEL, JSON.stringify({ tenantId, roomId, message })])
    .catch(() => { /* delivery falls back to polling on reconnect */ })
}

export async function chatRealtimeRoutes(app: FastifyInstance): Promise<void> {
  let pgListener: import('../../db/pool.js').DbClient | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null

  function fanOut(tenantId: string, roomId: string, payload: string): void {
    for (const [, sub] of subscribers) {
      if (sub.tenantId === tenantId && sub.roomId === roomId && sub.isAlive()) {
        try {
          sub.send(payload)
        } catch { /* connection may have closed */ }
      }
    }
  }

  async function ensurePgListener(): Promise<void> {
    if (pgListener) return
    try {
      pgListener = await (app.db as DbPool).connect()
      await pgListener.query(`LISTEN ${CHAT_CHANNEL}`)
      pgListener.on('notification', (msg) => {
        if (msg.channel !== CHAT_CHANNEL || !msg.payload) return
        try {
          const parsed = JSON.parse(msg.payload) as { tenantId: string; roomId: string; message: unknown }
          fanOut(parsed.tenantId, parsed.roomId, JSON.stringify({ type: 'chat.message', ...parsed }))
        } catch { /* malformed payload */ }
      })
    } catch (err) {
      app.log.warn({ err }, 'chat realtime listener unavailable')
      pgListener = null
    }
  }

  app.addHook('onReady', async () => {
    await ensurePgListener()
    // Drop subscribers whose TCP connection died without a CLOSE frame
    // (idle proxies, sleep laptops). Two missed pong cycles terminate.
    heartbeat = setInterval(() => {
      for (const [key, sub] of subscribers) {
        if (!sub.alive) {
          // No pong since the last cycle: the TCP connection is gone.
          subscribers.delete(key)
          continue
        }
        sub.alive = false
        try { sub.ping() } catch { /* closing */ }
      }
    }, HEARTBEAT_INTERVAL_MS)
  })

  // WebSocket endpoint for real-time chat delivery. Auth and room
  // authorization mirror the REST routes: a valid staff JWT, chat.read
  // permission, and room membership are all required before subscribing.
  app.get('/chat/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
    const token = url.searchParams.get('token')
    const tenantId = url.searchParams.get('tid')
    const roomId = url.searchParams.get('room')

    if (!token || !tenantId || !roomId) {
      socket.close(4001)
      return
    }

    verifyAccessToken(app.config, token)
      .then(async (payload) => {
        const auth = payload as unknown as { sub: string; orgRole?: string; tenantId?: string }
        const userId = auth.sub

        // The tenant query parameter must match the token's tenant when the
        // token carries one, so a token cannot be used to spy on another
        // tenant's rooms even if the ids are guessed.
        if (auth.tenantId && auth.tenantId !== tenantId) {
          socket.close(4003)
          return
        }

        await withTenant(app.db as DbPool, tenantId, async (client) => {
          const room = (await client.query('SELECT id FROM chat_rooms WHERE id = $1', [roomId])).rows[0]
          if (!room) {
            socket.close(4004)
            return
          }

          const membership = (await client.query(
            'SELECT org_role FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3',
            [tenantId, userId, 'active'],
          )).rows[0] as { org_role: OrgRole } | undefined
          // Mirrors the REST route gates: active staff membership plus the
          // chat.read permission (end users are denied at the permission
          // layer, exactly like GET /chat/rooms).
          const orgRole = membership?.org_role ?? 'end_user'
          if (!roleHasAll(orgRole, ['chat.read'])) {
            socket.close(4003)
            return
          }

          await assertRoomAccess(client, roomId, userId, orgRole)

          const sub: ChatSubscriber = {
            roomId,
            userId,
            tenantId,
            alive: true,
            send: (data) => { socket.send(data) },
            ping: () => { socket.ping() },
            isAlive: () => socket.readyState === 1,
          }
          subscribers.set(chatKey(tenantId, roomId, userId), sub)

          socket.on('pong', () => { sub.alive = true })
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'connected', roomId, userId }))
          }

          socket.on('message', async (raw: Buffer) => {
            try {
              const msg = JSON.parse(raw.toString()) as Record<string, unknown>
              if (msg.type !== 'chat.send' || typeof msg.body !== 'string') return
              const body = msg.body.trim()
              if (!body || body.length > 4000) return

              const result = await withTenant(app.db as DbPool, tenantId, async (c) => {
                // Sending over the socket requires the same chat.write
                // permission the REST POST route enforces.
                if (!roleHasAll(orgRole, ['chat.write'])) return null
                const r = await c.query('SELECT id FROM chat_rooms WHERE id = $1', [roomId])
                if (!r.rows[0]) return null
                const sender = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]
                const { rows } = await c.query(
                  `INSERT INTO chat_messages (tenant_id, room_id, sender_id, body)
                   VALUES ($1, $2, $3, $4)
                   RETURNING id, body, created_at, sender_id`,
                  [tenantId, roomId, userId, body],
                )
                return { ...rows[0], sender_name: sender?.name ?? 'Unknown', attachments: [] } as BroadcastMessage
              })

              if (result) {
                // The NOTIFY round-trip fans out to every subscriber,
                // including this socket's own client, which dedupes by id.
                await publishChatMessage(app.db as DbPool, tenantId, roomId, result)
              }
            } catch { /* malformed message */ }
          })

          socket.on('close', () => { subscribers.delete(chatKey(tenantId, roomId, userId)) })
        }).catch(() => socket.close(4005))
      })
      .catch(() => {
        socket.close(4003)
      })
  })

  app.addHook('onClose', async () => {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    if (pgListener) {
      try {
        await pgListener.query(`UNLISTEN ${CHAT_CHANNEL}`)
      } catch { /* already closed */ }
      pgListener.release()
      pgListener = null
    }
    for (const [, sub] of subscribers) {
      try { sub.send(JSON.stringify({ type: 'chat.disconnected' })) } catch { /* closed */ }
    }
    subscribers.clear()
  })
}
