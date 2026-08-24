import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import { buildRelayApp } from '../src/index.js'
import { signTicket } from '../src/tickets.js'

const secret = 'relay-test-secret'
const SESSION = '00000000-0000-4000-8000-000000000001'
let nonceCounter = 0

function joinToken(aud: 'technician' | 'agent'): string {
  nonceCounter += 1
  return signTicket(secret, {
    sid: SESSION,
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

function waitFor(client: Client, predicate: (message: Message) => boolean, timeoutMs = 4000): Promise<Message> {
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

let app: FastifyInstance
let url: string

beforeAll(async () => {
  app = await buildRelayApp()
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 4100
  url = `ws://127.0.0.1:${port}/ws`
})

afterAll(async () => {
  await app.close()
})

describe('relay WebSocket trust boundary', () => {
  it('accepts a valid single-use join ticket', async () => {
    const client = await openClient(url)
    client.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('technician') }))
    const joined = await waitFor(client, (message) => message.type === 'joined')
    expect(joined.audience).toBe('technician')
    client.socket.close()
  })

  it('rejects a tampered join ticket', async () => {
    const token = joinToken('technician')
    const [payload, signature] = token.split('.')
    const tampered = `${payload}.${signature.slice(0, -1)}x`
    const client = await openClient(url)
    client.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: tampered }))
    const error = await waitFor(client, (message) => message.type === 'error')
    expect(error.code).toBe('invalid_join_ticket')
  })

  it('rejects join-ticket reuse across connections', async () => {
    const token = joinToken('technician')
    const first = await openClient(url)
    first.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: token }))
    await waitFor(first, (message) => message.type === 'joined')

    const second = await openClient(url)
    second.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: token }))
    const error = await waitFor(second, (message) => message.type === 'error')
    expect(error.code).toBe('invalid_join_ticket')
    first.socket.close()
    second.socket.close()
  })

  it('forwards chat between two peers in the same room', async () => {
    const technician = await openClient(url)
    technician.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('technician') }))
    await waitFor(technician, (message) => message.type === 'joined')

    const agent = await openClient(url)
    agent.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('agent') }))
    await waitFor(agent, (message) => message.type === 'joined')

    technician.socket.send(JSON.stringify({ type: 'chat', body: 'hello endpoint' }))
    const received = await waitFor(agent, (message) => message.type === 'chat')
    expect(received.body).toBe('hello endpoint')
    expect(received.from).toBe('technician')
    expect(received.sessionId).toBe(SESSION)
    technician.socket.close()
    agent.socket.close()
  })

  it('forwards agent monitor replies (display switching metadata) to technicians', async () => {
    const technician = await openClient(url)
    technician.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('technician') }))
    await waitFor(technician, (message) => message.type === 'joined')

    const agent = await openClient(url)
    agent.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('agent') }))
    await waitFor(agent, (message) => message.type === 'joined')

    agent.socket.send(JSON.stringify({ type: 'monitor', action: 'list', monitors: [{ id: 0, name: 'Primary', width: 1920, height: 1080 }] }))
    const received = await waitFor(technician, (message) => message.type === 'monitor')
    expect(received.action).toBe('list')
    expect(received.monitors[0].name).toBe('Primary')
    expect(received.from).toBe('agent')
    technician.socket.close()
    agent.socket.close()
  })

  it('restricts session_end to technicians', async () => {
    const technician = await openClient(url)
    technician.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('technician') }))
    await waitFor(technician, (message) => message.type === 'joined')

    const agent = await openClient(url)
    agent.socket.send(JSON.stringify({ type: 'join', sessionId: SESSION, joinToken: joinToken('agent') }))
    await waitFor(agent, (message) => message.type === 'joined')

    agent.socket.send(JSON.stringify({ type: 'session_end' }))
    const denied = await waitFor(agent, (message) => message.type === 'error')
    expect(denied.code).toBe('session_end_not_allowed')

    technician.socket.send(JSON.stringify({ type: 'session_end' }))
    const ended = await waitFor(agent, (message) => message.type === 'session_end')
    expect(ended.sessionId).toBe(SESSION)
    technician.socket.close()
    agent.socket.close()
  })
})
