import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('canned responses', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Canned Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreignOwner = await signupOwner(app, { tenantName: 'Foreign Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  let cannedId: string

  it('analyst cannot create canned responses (read-only role)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/canned-responses',
      headers: authHeaders(analyst),
      payload: { name: 'Nope', shortcut: 'nope', body: 'no' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('owner creates a canned response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/canned-responses',
      headers: authHeaders(owner),
      payload: {
        name: 'Password reset',
        shortcut: 'pwreset',
        body: 'Hi! To reset your password, please verify your identity with the security code sent to your manager.',
      },
    })
    expect(res.statusCode).toBe(201)
    cannedId = res.json().cannedResponse.id
    expect(res.json().cannedResponse.shortcut).toBe('pwreset')
  })

  it('duplicate shortcut is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/canned-responses',
      headers: authHeaders(owner),
      payload: { name: 'Another', shortcut: 'pwreset', body: 'dup' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('shortcut is trimmed and validated', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/canned-responses',
      headers: authHeaders(owner),
      payload: { name: 'Bad', shortcut: 'has space', body: 'x' },
    })
    expect(bad.statusCode).toBe(400)

    const trimmed = await app.inject({
      method: 'POST',
      url: '/api/v1/canned-responses',
      headers: authHeaders(owner),
      payload: { name: 'VPN guide', shortcut: '  vpn  ', body: 'restart the client' },
    })
    expect(trimmed.statusCode).toBe(201)
    expect(trimmed.json().cannedResponse.shortcut).toBe('vpn')
  })

  it('analyst can list and search canned responses', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/canned-responses?q=reset',
      headers: authHeaders(analyst),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cannedResponses.length).toBeGreaterThanOrEqual(1)
    expect(res.json().cannedResponses[0].name).toBe('Password reset')
  })

  it('end_user cannot read canned responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/canned-responses', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('owner updates a canned response', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/canned-responses/${cannedId}`,
      headers: authHeaders(owner),
      payload: { body: 'Updated: verify identity, then reset via the admin console.' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().cannedResponse.body).toContain('admin console')
  })

  it('canned responses are tenant-isolated', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/canned-responses', headers: authHeaders(foreignOwner) })
    expect(list.json().cannedResponses).toHaveLength(0)

    const steal = await app.inject({
      method: 'PATCH',
      url: `/api/v1/canned-responses/${cannedId}`,
      headers: authHeaders(foreignOwner),
      payload: { name: 'hijack' },
    })
    expect(steal.statusCode).toBe(404)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/canned-responses/${cannedId}`,
      headers: authHeaders(foreignOwner),
    })
    expect(del.statusCode).toBe(404)
  })

  it('owner deletes a canned response', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/canned-responses/${cannedId}`,
      headers: authHeaders(owner),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })
})
