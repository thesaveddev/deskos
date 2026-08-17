import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { notifyInTxn, setPushDispatcher } from '../src/core/notify.js'
import { generateVapidKeyPair } from '../src/modules/push/vapid.js'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

const vapid = generateVapidKeyPair()

function subscriberKeys(): { p256dh: Buffer; auth: Buffer } {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    p256dh: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-65),
    auth: randomBytes(16),
  }
}

describe('Web Push notifications', () => {
  let app: FastifyInstance
  let disabledApp: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let member: Awaited<ReturnType<typeof seedActiveMember>>
  let captured: Array<{ endpoint: string; headers: Record<string, string>; body: Buffer }>

  beforeAll(async () => {
    app = await createTestApp({
      DESKOS_VAPID_PUBLIC_KEY: vapid.publicKey,
      DESKOS_VAPID_PRIVATE_KEY: vapid.privateKey,
      DESKOS_VAPID_SUBJECT: 'mailto:test@deskos.local',
    })
    disabledApp = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Push Org' })
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    member = await seedActiveMember(app, owner.tenantId!, 'analyst')
    captured = []
    app.pushHttp = async (endpoint, init) => {
      captured.push({ endpoint, headers: init.headers as Record<string, string>, body: init.body as Buffer })
      return { status: 201 }
    }
  })

  afterAll(async () => {
    await app.close()
    await disabledApp.close()
  })

  it('exposes the VAPID public key only when configured', async () => {
    const enabled = await app.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key' })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().publicKey).toBe(vapid.publicKey)

    const disabled = await disabledApp.inject({ method: 'GET', url: '/api/v1/push/vapid-public-key' })
    expect(disabled.statusCode).toBe(503)
    expect(disabled.json().error.code).toBe('push_disabled')
  })

  it('saves, lists, and deletes a subscription without leaking keys', async () => {
    const sub = subscriberKeys()
    const save = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(owner),
      payload: {
        endpoint: 'https://push.example.test/abc',
        p256dh: sub.p256dh.toString('base64url'),
        auth: sub.auth.toString('base64url'),
        userAgent: 'vitest',
      },
    })
    expect(save.statusCode).toBe(201)
    const id = save.json().subscription.id as string
    expect(JSON.stringify(save.json())).not.toContain('p256dh')
    expect(JSON.stringify(save.json())).not.toContain('auth')

    const list = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(list.json().subscriptions).toHaveLength(1)

    // Re-saving the same endpoint upserts rather than duplicating.
    const reSave = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(owner),
      payload: {
        endpoint: 'https://push.example.test/abc',
        p256dh: sub.p256dh.toString('base64url'),
        auth: sub.auth.toString('base64url'),
      },
    })
    expect(reSave.statusCode).toBe(201)
    const list2 = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(owner) })
    expect(list2.json().subscriptions).toHaveLength(1)

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/push/subscriptions/${id}`, headers: authHeaders(owner) })
    expect(del.statusCode).toBe(200)
    const delAgain = await app.inject({ method: 'DELETE', url: `/api/v1/push/subscriptions/${id}`, headers: authHeaders(owner) })
    expect(delAgain.statusCode).toBe(404)
  })

  it('rejects malformed subscription keys', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(owner),
      payload: { endpoint: 'https://push.example.test/x', p256dh: 'AAAA', auth: Buffer.alloc(16).toString('base64url') },
    })
    expect(bad.statusCode).toBe(400)

    const badAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(owner),
      payload: {
        endpoint: 'https://push.example.test/x',
        p256dh: subscriberKeys().p256dh.toString('base64url'),
        auth: 'short',
      },
    })
    expect(badAuth.statusCode).toBe(400)
  })

  it('scopes subscriptions per user (any member, own rows only)', async () => {
    const sub = subscriberKeys()
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(endUser),
      payload: {
        endpoint: 'https://push.example.test/user-x',
        p256dh: sub.p256dh.toString('base64url'),
        auth: sub.auth.toString('base64url'),
      },
    })

    const memberList = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(member) })
    expect(memberList.json().subscriptions).toHaveLength(0)

    const endUserList = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(endUser) })
    expect(endUserList.json().subscriptions).toHaveLength(1)

    const otherTenant = await signupOwner(app, { tenantName: 'Push Foreign' })
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(otherTenant) })
    expect(foreignList.json().subscriptions).toHaveLength(0)
  })

  it('sends a signed, encrypted test push and removes gone endpoints', async () => {
    const sub = subscriberKeys()
    await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscriptions',
      headers: authHeaders(owner),
      payload: {
        endpoint: 'https://push.example.test/deliver',
        p256dh: sub.p256dh.toString('base64url'),
        auth: sub.auth.toString('base64url'),
      },
    })

    const test = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions/test', headers: authHeaders(owner) })
    expect(test.statusCode).toBe(200)
    expect(test.json().delivered).toBe(1)

    expect(captured).toHaveLength(1)
    const req = captured[0]
    expect(req.endpoint).toBe('https://push.example.test/deliver')
    expect(req.headers['content-encoding']).toBe('aes128gcm')
    expect(req.headers['content-type']).toBe('application/octet-stream')
    expect(req.headers.ttl).toBe(String(app.config.push.ttlSec))
    expect(req.headers.authorization).toMatch(/^vapid t=[^,]+,k=/)
    // salt(16) + rs(4) + idlen(1) + key(65) + ciphertext
    expect(req.body.length).toBeGreaterThan(86)

    // A gone endpoint is removed so stale rows do not linger.
    app.pushHttp = async () => ({ status: 410 })
    const gone = await app.inject({ method: 'POST', url: '/api/v1/push/subscriptions/test', headers: authHeaders(owner) })
    expect(gone.json().removed).toBe(1)
    const after = await app.inject({ method: 'GET', url: '/api/v1/push/subscriptions', headers: authHeaders(owner) })
    expect(after.json().subscriptions).toHaveLength(0)
  })

  it('dispatches push through notify() when in-app delivery happens', async () => {
    const dispatched: Array<{ tenantId: string; userId: string; kind: string; body: string }> = []
    setPushDispatcher((input) => {
      dispatched.push(input)
      return Promise.resolve(0)
    })
    try {
      await notifyInTxn(app.db, owner.tenantId!, {
        userId: owner.userId,
        kind: 'ticket.replied',
        body: 'A ticket was replied to.',
      })
      expect(dispatched).toHaveLength(1)
      expect(dispatched[0].kind).toBe('ticket.replied')
      expect(dispatched[0].userId).toBe(owner.userId)
    } finally {
      setPushDispatcher(null)
    }
  })
})
