import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('team chat', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let roomId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Chat Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'Chat Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('denies end users and allows analysts to read chat', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(analyst) })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().rooms).toEqual([])
  })

  it('creates rooms and rejects duplicate names', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'General' } })
    expect(created.statusCode).toBe(201)
    roomId = created.json().room.id

    const dup = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'General' } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('duplicate_room')
  })

  it('posts and lists messages with sender info', async () => {
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst), payload: { body: 'Hello team' } })
    expect(sent.statusCode).toBe(201)
    expect(sent.json().message.body).toBe('Hello team')

    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const messages = list.json().messages as Array<{ body: string; sender_name: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Hello team')
    expect(messages[0].sender_name).toBe('analyst user')
  })

  it('rejects blank or oversized message bodies', async () => {
    const blank = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(owner), payload: { body: '   ' } })
    expect(blank.statusCode).toBe(400)
  })

  it('isolates rooms and messages between tenants', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(foreign) })
    expect(list.statusCode).toBe(404)

    const foreignRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(foreign) })
    expect(foreignRooms.json().rooms).toEqual([])
  })
})
