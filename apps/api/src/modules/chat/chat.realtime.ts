import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import { verifyAccessToken } from '../../core/auth/jwt.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import '../../types.js'

const CHAT_CHANNEL = 'deskos_chat'

type ChatSubscriber = {
  roomId: string
  userId: string
  tenantId: string
  send: (data: string) => void
}

const subscribers = new Map<string, ChatSubscriber>()

function chatKey(tenantId: string, roomId: string, userId: string): string {
  return `${tenantId}:${roomId}:${userId}`
}

function subscribe(tenantId: string, roomId: string, userId: string, send: (data: string) => void): () => void {
  const key = chatKey(tenantId, roomId, userId)
  const sub: ChatSubscriber = { roomId, userId, tenantId, send }
  subscribers.set(key, sub)
  return () => { subscribers.delete(key) }
}

export async function chatRealtimeRoutes(app: FastifyInstance): Promise<void> {
  let pgListener: import('../../db/pool.js').DbClient | null = null

  async function ensurePgListener(): Promise<void> {
    if (pgListener) return
    try {
      pgListener = await (app.db as DbPool).connect()
      await pgListener.query(`LISTEN ${CHAT_CHANNEL}`)
      pgListener.on('notification', (msg) => {
        if (msg.channel !== CHAT_CHANNEL || !msg.payload) return
        try {
          const parsed = JSON.parse(msg.payload) as { tenantId: string; roomId: string; message: unknown }
          for (const [, sub] of subscribers) {
            if (sub.tenantId === parsed.tenantId && sub.roomId === parsed.roomId) {
              try {
                sub.send(JSON.stringify({ type: 'chat.message', ...parsed }))
              } catch { /* connection may have closed */ }
            }
          }
        } catch { /* malformed payload */ }
      })
    } catch (err) {
      app.log.warn({ err }, 'chat realtime listener unavailable')
      pgListener = null
    }
  }

  app.addHook('onReady', async () => {
    await ensurePgListener()
  })

  // WebSocket endpoint for real-time chat
  app.get('/chat/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
    const token = url.searchParams.get('token')
    const tenantId = url.searchParams.get('tid')
    const roomId = url.searchParams.get('room')

    if (!token || !tenantId || !roomId) {
      socket.close(4001)
      return
    }

    // Verify JWT token asynchronously, then proceed
    verifyAccessToken(app.config, token)
      .then((payload) => {
        const userId = (payload as unknown as { sub: string }).sub

        withTenant(app.db as DbPool, tenantId, async (client) => {
          const room = (await client.query(
            'SELECT id FROM chat_rooms WHERE id = $1',
            [roomId],
          )).rows[0]

          if (!room) {
            socket.close(4004)
            return
          }

          const unsub = subscribe(tenantId, roomId, userId, (data) => {
            if (socket.readyState === 1) {
              socket.send(data)
            }
          })

          if (socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'connected', roomId, userId }))
          }

          socket.on('message', async (raw: Buffer) => {
            try {
              const msg = JSON.parse(raw.toString()) as Record<string, unknown>

              if (msg.type === 'chat.send' && typeof msg.body === 'string') {
                const body = msg.body.trim()
                if (!body || body.length > 4000) return

                const result = await withTenant(app.db as DbPool, tenantId, async (c) => {
                  const r = await c.query(
                    'SELECT id, name FROM chat_rooms WHERE id = $1',
                    [roomId],
                  )
                  if (!r.rows[0]) return null

                  const sender = (await c.query('SELECT name FROM users WHERE id = $1', [userId])).rows[0]
                  const { rows } = await c.query(
                    `INSERT INTO chat_messages (tenant_id, room_id, sender_id, body)
                     VALUES ($1, $2, $3, $4)
                     RETURNING id, body, created_at, sender_id`,
                    [tenantId, roomId, userId, body],
                  )

                  return {
                    ...rows[0],
                    sender_name: sender?.name ?? 'Unknown',
                    attachments: [],
                  }
                })

                if (result) {
                  for (const [, sub] of subscribers) {
                    if (sub.tenantId === tenantId && sub.roomId === roomId) {
                      try {
                        sub.send(JSON.stringify({ type: 'chat.message', tenantId, roomId, message: result }))
                      } catch { /* closed */ }
                    }
                  }
                  await (app.db as DbPool).query(
                    'SELECT pg_notify($1, $2)',
                    [CHAT_CHANNEL, JSON.stringify({ tenantId, roomId, message: result })],
                  ).catch(() => {})
                }
              } else if (msg.type === 'chat.file' && typeof msg.filename === 'string') {
                for (const [, sub] of subscribers) {
                  if (sub.tenantId === tenantId && sub.roomId === roomId) {
                    try {
                      sub.send(JSON.stringify({ type: 'chat.file_shared', tenantId, roomId, filename: msg.filename, userId }))
                    } catch { /* closed */ }
                  }
                }
              }
            } catch { /* malformed message */ }
          })

          socket.on('close', () => unsub())
        }).catch(() => socket.close(4005))
      })
      .catch(() => {
        socket.close(4003)
      })
  })

  app.addHook('onClose', async () => {
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
