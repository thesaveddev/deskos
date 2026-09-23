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
  name: string | null
  alive: boolean
  lastTypingAt: number
  send: (data: string) => void
  ping: () => void
  isAlive: () => boolean
}

const TYPING_MIN_INTERVAL_MS = 1_500

const subscribers = new Map<string, ChatSubscriber>()
// Connections are keyed per socket, not per user: the same user in two
// tabs must keep two live subscriptions that close independently.
let subscriberSeq = 0

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
export async function publishChatMessage(
  pool: DbPool,
  tenantId: string,
  roomId: string,
  message: BroadcastMessage,
  type: 'chat.message' | 'chat.message.updated' = 'chat.message',
): Promise<void> {
  await pool
    .query('SELECT pg_notify($1, $2)', [CHAT_CHANNEL, JSON.stringify({ tenantId, roomId, type, message })])
    .catch(() => { /* delivery falls back to polling on reconnect */ })
}

export async function chatRealtimeRoutes(app: FastifyInstance): Promise<void> {
  let pgListener: import('../../db/pool.js').DbClient | null = null
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let listenerRetry: ReturnType<typeof setTimeout> | null = null

  function fanOut(tenantId: string, roomId: string, payload: string, excludeUserId?: string): void {
    for (const [, sub] of subscribers) {
      if (sub.tenantId === tenantId && sub.roomId === roomId && sub.isAlive() && sub.userId !== excludeUserId) {
        try {
          sub.send(payload)
        } catch { /* connection may have closed */ }
      }
    }
  }

  // The LISTEN connection is what makes delivery real-time. It used to be
  // attempted once at boot with no error handler: a single transient failure
  // (or a later connection drop) left every publish fanning out to nobody
  // until the next restart. Retry until it is back, and recover if the
  // connection dies at runtime.
  function scheduleListenerRetry(): void {
    if (listenerRetry) return
    listenerRetry = setTimeout(() => {
      listenerRetry = null
      void ensurePgListener()
    }, 5_000)
  }

  async function ensurePgListener(): Promise<void> {
    if (pgListener) return
    let client: import('../../db/pool.js').DbClient | null = null
    try {
      client = await (app.db as DbPool).connect()
      client.on('error', (err: Error) => {
        app.log.warn({ err }, 'chat realtime listener connection lost')
        if (pgListener === client) pgListener = null
        try { client?.release() } catch { /* already released */ }
        scheduleListenerRetry()
      })
      await client.query(`LISTEN ${CHAT_CHANNEL}`)
      client.on('notification', (msg) => {
        if (msg.channel !== CHAT_CHANNEL || !msg.payload) return
        try {
          const parsed = JSON.parse(msg.payload) as { tenantId: string; roomId: string; message: unknown; type?: string }
          fanOut(parsed.tenantId, parsed.roomId, JSON.stringify({ ...parsed, type: parsed.type ?? 'chat.message' }))
        } catch { /* malformed payload */ }
      })
      pgListener = client
    } catch (err) {
      app.log.warn({ err }, 'chat realtime listener unavailable')
      try { client?.release() } catch { /* never acquired */ }
      scheduleListenerRetry()
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
            `SELECT m.org_role, u.name
               FROM memberships m
               JOIN users u ON u.id = m.user_id
              WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = $3`,
            [tenantId, userId, 'active'],
          )).rows[0] as { org_role: OrgRole; name: string | null } | undefined
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
            name: membership?.name ?? null,
            alive: true,
            lastTypingAt: 0,
            send: (data) => { socket.send(data) },
            ping: () => { socket.ping() },
            isAlive: () => socket.readyState === 1,
          }
          const connKey = `${chatKey(tenantId, roomId, userId)}#${++subscriberSeq}`
          subscribers.set(connKey, sub)

          socket.on('pong', () => { sub.alive = true })
          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'connected', roomId, userId }))
          }

          socket.on('message', async (raw: Buffer) => {
            try {
              const msg = JSON.parse(raw.toString()) as Record<string, unknown>
              if (msg.type === 'chat.typing') {
                // Ephemeral presence: rate-limited per socket, forwarded only
                // to other room members, and gated on chat.write so read-only
                // observers cannot inject typing noise.
                if (!roleHasAll(orgRole, ['chat.write'])) return
                const now = Date.now()
                if (now - sub.lastTypingAt < TYPING_MIN_INTERVAL_MS) return
                sub.lastTypingAt = now
                fanOut(
                  tenantId,
                  roomId,
                  JSON.stringify({ type: 'chat.typing', roomId, userId, name: sub.name }),
                  userId,
                )
                return
              }
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

          socket.on('close', () => { subscribers.delete(connKey) })
        }).catch(() => socket.close(4005))
      })
      .catch(() => {
        socket.close(4003)
      })
  })

  app.addHook('onClose', async () => {
    if (listenerRetry) {
      clearTimeout(listenerRetry)
      listenerRetry = null
    }
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
