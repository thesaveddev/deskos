import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createClient } from 'redis'
import { createRelayRuntime, type RelayRuntime } from '../src/index.js'
import { signTicket } from '../src/tickets.js'

const secret = 'relay-failover-test-secret'
// The distributed-registry harness requires a reachable Redis (the run doc
// already establishes local Redis 5 as a development dependency). Override with
// TEST_REDIS_URL when the test environment uses a different instance.
const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379'
const prefix = `deskos:relay:test:${randomUUID()}`
let nonceCounter = 0

function newSession(): string {
  return randomUUID()
}

function joinToken(sessionId: string, aud: 'technician' | 'agent'): string {
  nonceCounter += 1
  return signTicket(secret, {
    sid: sessionId,
    aud,
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: `nonce-${nonceCounter}`,
  })
}

type Message = Record<string, unknown>

interface Client {
  socket: WebSocket
  inbox: Message[]
  waiters: Array<{ predicate: (message: Message) => boolean; resolve: (message: Message) => void }>
}

function openClient(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client: Client = { socket: new WebSocket(url), inbox: [], waiters: [] }
    client.socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as Message
      const index = client.waiters.findIndex((waiter) => waiter.predicate(message))
      if (index >= 0) {
        const [waiter] = client.waiters.splice(index, 1)
        waiter.resolve(message)
      } else {
        client.inbox.push(message)
      }
    })
    client.socket.on('open', () => resolve(client))
    client.socket.on('error', reject)
  })
}

function waitFor(client: Client, predicate: (message: Message) => boolean, timeoutMs = 8000): Promise<Message> {
  const existingIndex = client.inbox.findIndex(predicate)
  if (existingIndex >= 0) {
    const [message] = client.inbox.splice(existingIndex, 1)
    return Promise.resolve(message)
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for relay message')), timeoutMs)
    client.waiters.push({
      predicate,
      resolve: (message) => {
        clearTimeout(timer)
        resolve(message)
      },
    })
  })
}

async function listen(runtime: RelayRuntime): Promise<string> {
  await runtime.app.listen({ port: 0, host: '127.0.0.1' })
  const address = runtime.app.server.address()
  const port = typeof address === 'object' && address ? address.port : 4100
  return `ws://127.0.0.1:${port}/ws`
}

async function join(url: string, sessionId: string, audience: 'technician' | 'agent'): Promise<Client> {
  const client = await openClient(url)
  client.socket.send(JSON.stringify({ type: 'join', sessionId, joinToken: joinToken(sessionId, audience) }))
  const joined = await waitFor(client, (message) => message.type === 'joined')
  expect(joined.audience).toBe(audience)
  return client
}

describe('relay distributed registry failover', () => {
  let relayA: RelayRuntime
  let relayB: RelayRuntime
  let urlA: string
  let urlB: string

  beforeAll(async () => {
    relayA = await createRelayRuntime({ relaySecret: secret, redisUrl, redisPrefix: prefix })
    relayB = await createRelayRuntime({ relaySecret: secret, redisUrl, redisPrefix: prefix })
    await relayA.connectRedis()
    await relayB.connectRedis()
    urlA = await listen(relayA)
    urlB = await listen(relayB)
  })

  afterAll(async () => {
    await relayA.close()
    await relayB.close()
  })

  it('reports the redis registry as ready on both instances', async () => {
    expect(relayA.stats().registry).toBe('redis')
    expect(relayB.stats().registry).toBe('redis')
  })

  it('forwards chat and signalling across two relay instances via Redis', async () => {
    const sessionId = newSession()
    const technician = await join(urlA, sessionId, 'technician')
    const agent = await join(urlB, sessionId, 'agent')

    // The agent joined a different instance but still sees the technician
    // through the Redis-backed membership registry.
    const agentJoined = await waitFor(agent, (message) => message.type === 'peer_joined')
    expect(agentJoined.audience).toBe('technician')

    technician.socket.send(JSON.stringify({ type: 'chat', body: 'hello across relays' }))
    const chat = await waitFor(agent, (message) => message.type === 'chat')
    expect(chat.body).toBe('hello across relays')
    expect(chat.from).toBe('technician')
    expect(chat.sessionId).toBe(sessionId)

    agent.socket.send(JSON.stringify({ type: 'sdp', description: { type: 'offer', sdp: 'v=0' } }))
    const sdp = await waitFor(technician, (message) => message.type === 'sdp')
    expect((sdp.description as Record<string, unknown>).type).toBe('offer')

    technician.socket.close()
    agent.socket.close()
  })

  it('keeps the room registry alive when one relay instance goes away', async () => {
    const sessionId = newSession()
    const technician = await join(urlA, sessionId, 'technician')
    const agent = await join(urlB, sessionId, 'agent')
    await waitFor(agent, (message) => message.type === 'peer_joined')

    // Simulate a rolling restart: the technician leaves and its relay stops.
    technician.socket.close()
    await waitFor(agent, (message) => message.type === 'peer_left' && message.audience === 'technician')
    await relayA.close()

    // A fresh technician joins the surviving relay and still finds the agent.
    const technician2 = await join(urlB, sessionId, 'technician')
    await waitFor(agent, (message) => message.type === 'peer_joined' && message.audience === 'technician')

    technician2.socket.send(JSON.stringify({ type: 'chat', body: 'still there?' }))
    const chat = await waitFor(agent, (message) => message.type === 'chat')
    expect(chat.body).toBe('still there?')
    expect(chat.from).toBe('technician')

    technician2.socket.close()
    agent.socket.close()
  })

  it('sweeps stale room members left behind by a crashed peer', async () => {
    const sessionId = newSession()
    const agent = await join(urlB, sessionId, 'agent')

    // Inject expired members as if a relay crashed without graceful cleanup.
    const client = createClient({ url: redisUrl, RESP: 2 })
    await client.connect()
    const membersKey = `${prefix}:room:${sessionId}:members`
    for (let index = 0; index < 4; index += 1) {
      const stale = JSON.stringify({ connectionId: `crashed:${index}`, audience: 'technician' })
      await client.zAdd(membersKey, { score: Date.now() - 120_000, value: stale })
    }
    await client.quit()

    // The stale members must be swept before the capacity check, so a new
    // technician still joins and sees only the live agent (peers = 1).
    const technician = await openClient(urlB)
    technician.socket.send(JSON.stringify({ type: 'join', sessionId, joinToken: joinToken(sessionId, 'technician') }))
    const joined = await waitFor(technician, (message) => message.type === 'joined')
    expect(joined.audience).toBe('technician')
    expect(joined.peers).toBe(1)
    await waitFor(agent, (message) => message.type === 'peer_joined' && message.audience === 'technician')

    technician.socket.close()
    agent.socket.close()
  })
})
