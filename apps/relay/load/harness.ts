import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { signTicket } from '../src/tickets.js'

// Configurable via environment so the same harness can run as a quick smoke
// test or as a full 500-connection / 50-session load test.
const url = process.env.LOAD_URL ?? 'ws://127.0.0.1:4100/ws'
const secret = process.env.LOAD_SECRET ?? process.env.DESKOS_RELAY_SECRET ?? 'deskos-relay-dev-only'
const connections = Number(process.env.LOAD_CONNECTIONS ?? 40)
const sessions = Number(process.env.LOAD_SESSIONS ?? 8)
const messagesPerPeer = Number(process.env.LOAD_MESSAGES ?? 5)
const reconnectRounds = Number(process.env.LOAD_RECONNECTS ?? 2)
const joinTimeoutMs = Number(process.env.LOAD_JOIN_TIMEOUT ?? 5000)
const burstMessages = Number(process.env.LOAD_BURST ?? 1010)

type Message = Record<string, unknown>

interface PeerState {
  inbox: Message[]
  waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }>
}

interface Peer {
  sessionId: string
  audience: 'technician' | 'agent'
  socket: WebSocket
  state: PeerState
}

let nonce = 0

function joinToken(sessionId: string, audience: 'technician' | 'agent'): string {
  nonce += 1
  return signTicket(secret, {
    sid: sessionId,
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: `load-${process.pid}-${nonce}`,
  })
}

function connectSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.on('open', () => resolve(socket))
    socket.on('error', reject)
  })
}

function attach(socket: WebSocket): PeerState {
  const state: PeerState = { inbox: [], waiters: [] }
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString()) as Message
    const index = state.waiters.findIndex((waiter) => waiter.predicate(message))
    if (index >= 0) {
      const [waiter] = state.waiters.splice(index, 1)
      waiter.resolve(message)
    } else {
      state.inbox.push(message)
    }
  })
  return state
}

function waitFor(state: PeerState, predicate: (message: Message) => boolean, timeoutMs: number): Promise<Message> {
  const existingIndex = state.inbox.findIndex(predicate)
  if (existingIndex >= 0) {
    const [message] = state.inbox.splice(existingIndex, 1)
    return Promise.resolve(message)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for relay message')), timeoutMs)
    state.waiters.push({
      predicate,
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
    })
  })
}

function elapsed(start: number): number {
  return Math.round((Date.now() - start) / 10) / 100
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index]
}

async function openPeer(sessionId: string, audience: 'technician' | 'agent'): Promise<Peer> {
  const socket = await connectSocket(url)
  return { sessionId, audience, socket, state: attach(socket) }
}

async function joinPeer(peer: Peer): Promise<number> {
  const start = Date.now()
  peer.socket.send(JSON.stringify({ type: 'join', sessionId: peer.sessionId, joinToken: joinToken(peer.sessionId, peer.audience) }))
  const joined = await waitFor(peer.state, (message) => message.type === 'joined', joinTimeoutMs)
  if (joined.audience !== peer.audience) throw new Error(`joined with wrong audience: ${String(joined.audience)}`)
  return Date.now() - start
}

async function main(): Promise<void> {
  const sessionIds = Array.from({ length: sessions }, () => randomUUID())
  const peers: Peer[] = []
  const joinLatencies: number[] = []
  // Extra sockets exercise raw connection capacity on top of the session pairs.
  const headroom = Math.max(0, connections - sessions * 2)
  const headroomSockets: WebSocket[] = []

  const rampStart = Date.now()
  for (const sessionId of sessionIds) {
    const technician = await openPeer(sessionId, 'technician')
    const agent = await openPeer(sessionId, 'agent')
    peers.push(technician, agent)
    joinLatencies.push(await joinPeer(technician))
    joinLatencies.push(await joinPeer(agent))
  }
  for (let index = 0; index < headroom; index += 1) {
    headroomSockets.push(await connectSocket(url))
  }
  const rampSeconds = elapsed(rampStart)

  // Message churn: every peer sends chat to its room and expects its
  // counterpart to receive every message exactly once.
  let delivered = 0
  let expectedDeliveries = 0
  const churnStart = Date.now()
  await Promise.all(
    peers.map(async (peer, index) => {
      const counterpart = index % 2 === 0 ? peers[index + 1] : peers[index - 1]
      for (let messageIndex = 0; messageIndex < messagesPerPeer; messageIndex += 1) {
        peer.socket.send(JSON.stringify({ type: 'chat', body: `${peer.audience}-${messageIndex}` }))
      }
      for (let messageIndex = 0; messageIndex < messagesPerPeer; messageIndex += 1) {
        const received = await waitFor(counterpart.state, (message) => message.type === 'chat', joinTimeoutMs)
        if (received.body === `${peer.audience}-${messageIndex}`) delivered += 1
        expectedDeliveries += 1
      }
    }),
  )
  const churnSeconds = elapsed(churnStart)

  // Reconnect storm: drop and rejoin every peer with a fresh ticket.
  let reconnectSuccess = 0
  const reconnectStart = Date.now()
  for (let round = 0; round < reconnectRounds; round += 1) {
    for (const peer of peers) peer.socket.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    for (const peer of peers) {
      peer.socket = await connectSocket(url)
      peer.state = attach(peer.socket)
      await joinPeer(peer)
      reconnectSuccess += 1
    }
  }
  const reconnectSeconds = elapsed(reconnectStart)

  // Rate-limit enforcement: a flooder must be told to slow down.
  const ratePeer = await openPeer(sessionIds[0], 'technician')
  await joinPeer(ratePeer)
  const burstStart = Date.now()
  for (let index = 0; index < burstMessages; index += 1) {
    ratePeer.socket.send(JSON.stringify({ type: 'chat', body: `burst-${index}` }))
  }
  const rateLimited = await waitFor(ratePeer.state, (message) => message.type === 'error' && message.code === 'message_rate_limited', joinTimeoutMs)
  const burstSeconds = elapsed(burstStart)

  // Graceful drain: close everything and let the relay settle.
  const drainStart = Date.now()
  for (const peer of peers) peer.socket.close()
  for (const socket of headroomSockets) socket.close()
  ratePeer.socket.close()
  await new Promise((resolve) => setTimeout(resolve, 200))
  const drainSeconds = elapsed(drainStart)

  console.log(
    JSON.stringify(
      {
        url,
        connections: peers.length + headroomSockets.length,
        sessionPeers: peers.length,
        sessions,
        ramp: { seconds: rampSeconds, joinLatencyP95Ms: percentile(joinLatencies, 95) },
        churn: { seconds: churnSeconds, delivered, expected: expectedDeliveries },
        reconnect: { rounds: reconnectRounds, successes: reconnectSuccess, seconds: reconnectSeconds },
        rateLimit: { enforced: Boolean(rateLimited), seconds: burstSeconds },
        drain: { seconds: drainSeconds },
      },
      null,
      2,
    ),
  )

  const failures: string[] = []
  if (delivered !== expectedDeliveries) failures.push(`message delivery ${delivered}/${expectedDeliveries}`)
  if (reconnectSuccess !== peers.length * reconnectRounds) failures.push('reconnect storm')
  if (!rateLimited) failures.push('rate limit not enforced')
  if (failures.length > 0) {
    console.error(`LOAD FAILED: ${failures.join('; ')}`)
    process.exit(1)
  }
  console.log('LOAD OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
