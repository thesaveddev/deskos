import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import websocket from '@fastify/websocket'
import { createClient } from 'redis'
import { InMemoryTicketStore, ticketHash, verifyTicket, type RelayTicket } from './tickets.js'

interface RelaySocket {
  readyState: number
  send(data: string): void
  close(): void
  on(event: 'message', listener: (data: { toString(): string }) => void): void
  on(event: 'close', listener: () => void): void
}

interface Peer extends RelaySocket {
  connectionId: string
  sessionId?: string
  audience?: RelayTicket['aud']
  redisMember?: string
  messageWindowStartedAt?: number
  messagesInWindow?: number
}

type RedisConnection = ReturnType<typeof createClient>
type RoomMember = { connectionId: string; audience: RelayTicket['aud'] }
type RoomEnvelope = { sourceId: string; message: Record<string, unknown> }

export interface RelayRuntimeOptions {
  relaySecret: string
  redisUrl?: string
  redisPrefix?: string
  maxConnections?: number
  maxPeersPerSession?: number
  maxMessagesPerSecond?: number
  maxMessageBytes?: number
  roomMemberTtlMs?: number
  memberHeartbeatMs?: number
  /** Browser origins allowed to open relay WebSockets; requests without Origin (native agents) remain allowed. */
  allowedOrigins?: string[]
}

export interface RelayRuntimeStats {
  sessions: number
  connections: number
  capacity: number
  registry: 'redis' | 'in-memory'
}

export interface RelayRuntime {
  app: FastifyInstance
  connectRedis(): Promise<void>
  close(): Promise<void>
  stats(): RelayRuntimeStats
}

const defaultPort = Number(process.env.RELAY_PORT ?? process.env.PORT ?? 4100)

function setting(name: string): string | undefined {
  return process.env[name] ?? process.env[name.replace(/^REYDESK_/, 'DESKOS_')]
}
const defaultHost = process.env.HOST ?? '0.0.0.0'

function relaySecretFromEnvironment(): string {
  const secret = setting('REYDESK_RELAY_SECRET')?.trim()
  if (secret) {
    if (process.env.NODE_ENV === 'production' && secret.length < 32) {
      throw new Error('DESKOS_RELAY_SECRET must be at least 32 characters in production')
    }
    return secret
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DESKOS_RELAY_SECRET must be set in production')
  }
  return 'reydesk-relay-dev-only'
}

export async function createRelayRuntime(options: RelayRuntimeOptions): Promise<RelayRuntime> {
  const relaySecret = options.relaySecret
  const redisUrl = options.redisUrl ?? ''
  const redisPrefix = options.redisPrefix ?? 'reydesk:relay'
  const maxConnections = Math.max(1, options.maxConnections ?? 10_000)
  const maxPeersPerSession = Math.max(2, options.maxPeersPerSession ?? 4)
  const maxMessagesPerSecond = Math.max(50, options.maxMessagesPerSecond ?? 1_000)
  const maxMessageBytes = Math.max(4_096, options.maxMessageBytes ?? 64 * 1024)
  const roomMemberTtlMs = Math.max(10_000, options.roomMemberTtlMs ?? 60_000)
  const memberHeartbeatMs = Math.max(2_000, options.memberHeartbeatMs ?? 15_000)
  const allowedOrigins = (options.allowedOrigins ?? []).map((origin) => origin.trim()).filter(Boolean)

  const rooms = new Map<string, Set<Peer>>()
  const usedTickets = new InMemoryTicketStore()
  const subscriptions = new Set<string>()
  const processId = `${process.pid}-${randomUUID()}`
  let redisPublisher: RedisConnection | null = null
  let redisSubscriber: RedisConnection | null = null
  let redisReady = false
  let activeConnections = 0
  let totalMessages = 0
  let rejectedMessages = 0
  let rejectedConnections = 0
  let roomCapacityRejections = 0
  let closed = false
  let heartbeatTimer: NodeJS.Timeout | null = null

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
  })

  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/ws') || allowedOrigins.length === 0) return
    const origin = request.headers.origin
    // Native endpoint agents do not send Origin. Browser peers must be from
    // an explicitly configured console origin to reduce token abuse from an
    // unrelated website.
    if (origin && !allowedOrigins.includes(origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed' })
    }
  })

  function distributedRegistryEnabled(): boolean {
    return redisReady && redisPublisher?.isReady === true && redisSubscriber?.isReady === true
  }

  function roomChannel(sessionId: string): string {
    return `${redisPrefix}:room:${sessionId}:events`
  }

  function roomMembersKey(sessionId: string): string {
    return `${redisPrefix}:room:${sessionId}:members`
  }

  function ticketKey(token: string): string {
    return `${redisPrefix}:ticket:${ticketHash(token)}`
  }

  function send(socket: RelaySocket, message: Record<string, unknown>): void {
    if (socket.readyState === 1) socket.send(JSON.stringify(message))
  }

  function broadcastLocal(sessionId: string, sourceId: string, message: Record<string, unknown>): void {
    const room = rooms.get(sessionId)
    if (!room) return
    for (const peer of room) {
      if (peer.connectionId !== sourceId) send(peer, message)
    }
  }

  async function publishRoom(sessionId: string, sourceId: string, message: Record<string, unknown>): Promise<void> {
    if (!distributedRegistryEnabled()) return
    const envelope: RoomEnvelope = { sourceId, message }
    await redisPublisher!.publish(roomChannel(sessionId), JSON.stringify(envelope))
  }

  async function broadcast(sessionId: string, sourceId: string, message: Record<string, unknown>): Promise<void> {
    broadcastLocal(sessionId, sourceId, message)
    try {
      await publishRoom(sessionId, sourceId, message)
    } catch (error) {
      app.log.error({ err: error, sessionId }, 'relay pub/sub publish failed')
    }
  }

  async function subscribeRoom(sessionId: string): Promise<void> {
    if (!distributedRegistryEnabled() || subscriptions.has(sessionId)) return
    subscriptions.add(sessionId)
    await redisSubscriber!.subscribe(roomChannel(sessionId), (raw) => {
      let envelope: RoomEnvelope
      try {
        envelope = JSON.parse(raw) as RoomEnvelope
      } catch {
        return
      }
      if (!envelope.sourceId || envelope.sourceId.startsWith(`${processId}:`) || !envelope.message) return
      broadcastLocal(sessionId, envelope.sourceId, envelope.message)
    })
  }

  async function unsubscribeRoom(sessionId: string): Promise<void> {
    if (!redisSubscriber || !subscriptions.delete(sessionId)) return
    await redisSubscriber.unsubscribe(roomChannel(sessionId))
  }

  async function releaseRoomMember(peer: Peer): Promise<void> {
    const sessionId = peer.sessionId
    const room = sessionId ? rooms.get(sessionId) : undefined
    if (room && peer.sessionId) {
      room.delete(peer)
      if (room.size === 0) {
        rooms.delete(peer.sessionId)
        await unsubscribeRoom(peer.sessionId)
      }
    }
    if (sessionId && distributedRegistryEnabled() && peer.redisMember) {
      const membersKey = roomMembersKey(sessionId)
      await redisPublisher!.zRem(membersKey, peer.redisMember)
      if ((await redisPublisher!.zCard(membersKey)) === 0) await redisPublisher!.del(membersKey)
    }
    peer.sessionId = undefined
    peer.audience = undefined
    peer.redisMember = undefined
  }

  async function consumeTicket(token: string, expiresAt: number): Promise<boolean> {
    const now = Date.now()
    if (!distributedRegistryEnabled()) {
      return usedTickets.consume(token, expiresAt, now)
    }
    const ttl = Math.max(1, expiresAt - now)
    const result = await redisPublisher!.set(ticketKey(token), '1', { NX: true, PX: ttl })
    return result === 'OK'
  }

  async function existingRoomMembers(sessionId: string): Promise<RoomMember[]> {
    if (!distributedRegistryEnabled()) {
      return Array.from(rooms.get(sessionId) ?? []).map((peer) => ({
        connectionId: peer.connectionId,
        audience: peer.audience!,
      }))
    }
    const membersKey = roomMembersKey(sessionId)
    await redisPublisher!.zRemRangeByScore(membersKey, '-inf', Date.now() - roomMemberTtlMs)
    const members = await redisPublisher!.zRange(membersKey, 0, -1)
    return members.flatMap((member) => {
      try {
        const parsed = JSON.parse(member) as RoomMember
        return parsed.connectionId && parsed.audience ? [parsed] : []
      } catch {
        return []
      }
    })
  }

  async function claimRoomMember(peer: Peer, ticket: RelayTicket): Promise<{ count: number; existing: RoomMember[] } | null> {
    const existing = await existingRoomMembers(ticket.sid)
    const member: RoomMember = { connectionId: peer.connectionId, audience: ticket.aud }
    if (existing.length >= maxPeersPerSession) return null
    if (distributedRegistryEnabled()) {
      const encoded = JSON.stringify(member)
      await redisPublisher!.zAdd(roomMembersKey(ticket.sid), { score: Date.now(), value: encoded })
      const count = await redisPublisher!.zCard(roomMembersKey(ticket.sid))
      if (count > maxPeersPerSession) {
        await redisPublisher!.zRem(roomMembersKey(ticket.sid), encoded)
        return null
      }
      peer.redisMember = encoded
      return { count, existing }
    }
    return { count: existing.length + 1, existing }
  }

  function allowMessage(peer: Peer, raw: string): boolean {
    if (raw.length > maxMessageBytes) {
      rejectedMessages += 1
      send(peer, { type: 'error', code: 'message_too_large' })
      return false
    }
    const now = Date.now()
    if (!peer.messageWindowStartedAt || now - peer.messageWindowStartedAt >= 1_000) {
      peer.messageWindowStartedAt = now
      peer.messagesInWindow = 0
    }
    peer.messagesInWindow = (peer.messagesInWindow ?? 0) + 1
    totalMessages += 1
    if (peer.messagesInWindow > maxMessagesPerSecond) {
      rejectedMessages += 1
      send(peer, { type: 'error', code: 'message_rate_limited' })
      return false
    }
    return true
  }

  function prometheusMetrics(): string {
    return [
      '# HELP deskos_relay_active_connections Current WebSocket connections.',
      '# TYPE deskos_relay_active_connections gauge',
      `deskos_relay_active_connections ${activeConnections}`,
      '# HELP deskos_relay_active_sessions Current rooms with at least one local peer.',
      '# TYPE deskos_relay_active_sessions gauge',
      `deskos_relay_active_sessions ${rooms.size}`,
      '# HELP deskos_relay_messages_total Messages accepted for processing.',
      '# TYPE deskos_relay_messages_total counter',
      `deskos_relay_messages_total ${totalMessages}`,
      '# HELP deskos_relay_rejected_messages_total Messages rejected by size or rate limits.',
      '# TYPE deskos_relay_rejected_messages_total counter',
      `deskos_relay_rejected_messages_total ${rejectedMessages}`,
      '# HELP deskos_relay_rejected_connections_total Connections rejected at capacity.',
      '# TYPE deskos_relay_rejected_connections_total counter',
      `deskos_relay_rejected_connections_total ${rejectedConnections}`,
      '# HELP deskos_relay_room_capacity_rejections_total Session joins rejected by room capacity.',
      '# TYPE deskos_relay_room_capacity_rejections_total counter',
      `deskos_relay_room_capacity_rejections_total ${roomCapacityRejections}`,
    ].join('\n') + '\n'
  }

  async function handleMessage(peer: Peer, rawText: string): Promise<void> {
    if (!allowMessage(peer, rawText)) return
    let message: Record<string, unknown>
    try {
      message = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      send(peer, { type: 'error', code: 'invalid_json' })
      return
    }

    if (message.type === 'join') {
      const sessionId = typeof message.sessionId === 'string' ? message.sessionId : ''
      const token = typeof message.joinToken === 'string' ? message.joinToken : ''
      const ticket = verifyTicket(relaySecret, token)
      if (!sessionId || !ticket || ticket.sid !== sessionId) {
        send(peer, { type: 'error', code: 'invalid_join_ticket' })
        peer.close()
        return
      }
      const accepted = await consumeTicket(token, ticket.exp * 1000)
      if (!accepted) {
        send(peer, { type: 'error', code: 'invalid_join_ticket' })
        peer.close()
        return
      }
      await releaseRoomMember(peer)
      const claimed = await claimRoomMember(peer, ticket)
      if (!claimed) {
        roomCapacityRejections += 1
        send(peer, { type: 'error', code: 'session_capacity' })
        peer.close()
        return
      }
      const room = rooms.get(sessionId) ?? new Set<Peer>()
      room.add(peer)
      rooms.set(sessionId, room)
      await subscribeRoom(sessionId)
      peer.sessionId = sessionId
      peer.audience = ticket.aud
      send(peer, { type: 'joined', sessionId, audience: ticket.aud, peers: claimed.count - 1 })
      for (const existing of claimed.existing) {
        if (existing.connectionId !== peer.connectionId) {
          send(peer, { type: 'peer_joined', audience: existing.audience })
        }
      }
      void broadcast(sessionId, peer.connectionId, { type: 'peer_joined', audience: ticket.aud })
      return
    }

    if (!peer.sessionId || !peer.audience) {
      send(peer, { type: 'error', code: 'join_required' })
      return
    }

    if (message.type === 'session_end') {
      if (peer.audience !== 'technician') {
        send(peer, { type: 'error', code: 'session_end_not_allowed' })
        return
      }
      void broadcast(peer.sessionId, peer.connectionId, {
        type: 'session_end',
        from: peer.audience,
        sessionId: peer.sessionId,
      })
      return
    }

    if (['sdp', 'ice', 'control', 'chat', 'typing', 'state'].includes(String(message.type))) {
      void broadcast(peer.sessionId, peer.connectionId, {
        ...message,
        from: peer.audience,
        sessionId: peer.sessionId,
      })
      return
    }

    send(peer, { type: 'error', code: 'unsupported_message' })
  }

  async function heartbeatMembers(): Promise<void> {
    if (!distributedRegistryEnabled()) return
    const now = Date.now()
    for (const [sessionId, room] of rooms) {
      for (const peer of room) {
        if (peer.redisMember) {
          await redisPublisher!.zAdd(roomMembersKey(sessionId), { score: now, value: peer.redisMember })
        }
      }
    }
  }

  async function connectRedis(): Promise<void> {
    if (!redisUrl) return
    // The development machine currently runs Redis 5, so explicitly use RESP2;
    // Redis 6+/managed Redis may use RESP3, but RESP2 keeps the adapter compatible
    // with the supported self-hosted baseline.
    redisPublisher = createClient({ url: redisUrl, RESP: 2 })
    redisSubscriber = redisPublisher.duplicate()
    redisPublisher.on('error', (error) => app.log.error({ err: error }, 'relay Redis publisher error'))
    redisSubscriber.on('error', (error) => app.log.error({ err: error }, 'relay Redis subscriber error'))
    await redisPublisher.connect()
    await redisSubscriber.connect()
    redisReady = true
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        void heartbeatMembers().catch((error) => app.log.error({ err: error }, 'relay membership heartbeat failed'))
      }, memberHeartbeatMs)
      heartbeatTimer.unref?.()
    }
  }

  async function closeRedis(): Promise<void> {
    redisReady = false
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    if (redisSubscriber?.isOpen) await redisSubscriber.quit()
    if (redisPublisher?.isOpen) await redisPublisher.quit()
    redisSubscriber = null
    redisPublisher = null
  }

  await app.register(websocket)

  app.get('/healthz', async () => ({
    status: 'ok',
    service: 'reydesk-relay',
    sessions: rooms.size,
    connections: activeConnections,
    capacity: maxConnections,
    registry: distributedRegistryEnabled() ? 'redis' : 'in-memory',
  }))

  app.get('/readyz', async (_request, reply: FastifyReply) => {
    const production = process.env.NODE_ENV === 'production'
    const ready = !production || distributedRegistryEnabled()
    return reply.code(ready ? 200 : 503).send({
      status: ready ? 'ok' : 'not_ready',
      service: 'reydesk-relay',
      reason: ready ? undefined : 'redis_registry_not_configured',
      registry: distributedRegistryEnabled() ? 'redis' : 'in-memory',
    })
  })

  app.get('/metrics', async (_request, reply) => reply.type('text/plain; version=0.0.4').send(prometheusMetrics()))

  app.get('/ws', { websocket: true }, (socket) => {
    if (activeConnections >= maxConnections) {
      rejectedConnections += 1
      send(socket as unknown as RelaySocket, { type: 'error', code: 'relay_capacity' })
      socket.close()
      return
    }
    activeConnections += 1
    const peer = socket as unknown as Peer
    peer.connectionId = `${processId}:${randomUUID()}`
    peer.messageWindowStartedAt = Date.now()
    peer.messagesInWindow = 0

    socket.on('message', (raw: { toString(): string }) => {
      void handleMessage(peer, raw.toString()).catch((error) => {
        app.log.error({ err: error, connectionId: peer.connectionId }, 'relay message handling failed')
        send(peer, { type: 'error', code: 'relay_internal_error' })
      })
    })

    socket.on('close', () => {
      activeConnections = Math.max(0, activeConnections - 1)
      if (peer.sessionId) {
        void broadcast(peer.sessionId, peer.connectionId, { type: 'peer_left', audience: peer.audience })
      }
      void releaseRoomMember(peer).catch((error) => app.log.error({ err: error }, 'relay room cleanup failed'))
    })
  })

  return {
    app,
    connectRedis,
    close: async () => {
      if (closed) return
      closed = true
      await app.close()
      await closeRedis()
    },
    stats: () => ({
      sessions: rooms.size,
      connections: activeConnections,
      capacity: maxConnections,
      registry: distributedRegistryEnabled() ? 'redis' : 'in-memory',
    }),
  }
}

export async function buildRelayApp(): Promise<FastifyInstance> {
  const runtime = await createRelayRuntime({
    relaySecret: relaySecretFromEnvironment(),
    redisUrl: process.env.REDIS_URL ?? '',
    redisPrefix: process.env.RELAY_REDIS_PREFIX ?? 'reydesk:relay',
    maxConnections: Math.max(1, Number(process.env.RELAY_MAX_CONNECTIONS ?? 10_000)),
    maxPeersPerSession: Math.max(2, Number(process.env.RELAY_MAX_PEERS_PER_SESSION ?? 4)),
    maxMessagesPerSecond: Math.max(50, Number(process.env.RELAY_MAX_MESSAGES_PER_SECOND ?? 1_000)),
    maxMessageBytes: Math.max(4_096, Number(process.env.RELAY_MAX_MESSAGE_BYTES ?? 64 * 1024)),
    roomMemberTtlMs: Math.max(10_000, Number(process.env.RELAY_MEMBER_TTL_MS ?? 60_000)),
    memberHeartbeatMs: Math.max(2_000, Number(process.env.RELAY_MEMBER_HEARTBEAT_MS ?? 15_000)),
    allowedOrigins: relayAllowedOrigins(),
  })
  return runtime.app
}

function relayAllowedOrigins(): string[] {
  const origins = (process.env.RELAY_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (process.env.NODE_ENV === 'production' && origins.length === 0) {
    throw new Error('RELAY_ALLOWED_ORIGINS must be configured in production')
  }
  return origins
}

async function start(): Promise<void> {
  const runtime = await createRelayRuntime({
    relaySecret: relaySecretFromEnvironment(),
    redisUrl: process.env.REDIS_URL ?? '',
    redisPrefix: process.env.RELAY_REDIS_PREFIX ?? 'reydesk:relay',
    maxConnections: Math.max(1, Number(process.env.RELAY_MAX_CONNECTIONS ?? 10_000)),
    maxPeersPerSession: Math.max(2, Number(process.env.RELAY_MAX_PEERS_PER_SESSION ?? 4)),
    maxMessagesPerSecond: Math.max(50, Number(process.env.RELAY_MAX_MESSAGES_PER_SECOND ?? 1_000)),
    maxMessageBytes: Math.max(4_096, Number(process.env.RELAY_MAX_MESSAGE_BYTES ?? 64 * 1024)),
    roomMemberTtlMs: Math.max(10_000, Number(process.env.RELAY_MEMBER_TTL_MS ?? 60_000)),
    memberHeartbeatMs: Math.max(2_000, Number(process.env.RELAY_MEMBER_HEARTBEAT_MS ?? 15_000)),
    allowedOrigins: relayAllowedOrigins(),
  })
  await runtime.connectRedis()
  const shutdown = async () => {
    await runtime.close()
    process.exit(0)
  }
  process.once('SIGTERM', () => void shutdown())
  process.once('SIGINT', () => void shutdown())
  await runtime.app.listen({ port: defaultPort, host: defaultHost })
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false
if (isMain) {
  start().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
