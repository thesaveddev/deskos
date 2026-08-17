import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import type { WebauthnVerifier } from '../src/modules/auth/webauthn.js'

function makeMockVerifier(): WebauthnVerifier {
  return {
    async verifyRegistration(response) {
      const id = (response as { id?: string })?.id ?? 'cred-abc'
      return { credentialId: id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] }
    },
    async verifyAuthentication() {
      return { credentialId: 'cred-abc', newCounter: 7 }
    },
  }
}

describe('webauthn', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp({}, (instance) => {
      instance.decorate('webauthnVerifier', makeMockVerifier())
    })
    owner = await signupOwner(app, { tenantName: 'Passkey Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
  })

  afterAll(async () => {
    await app.close()
  })

  it('requires authentication to manage passkeys', async () => {
    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/webauthn/register/begin', payload: {} })
    expect(begin.statusCode).toBe(401)

    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/webauthn/credentials' })
    expect(list.statusCode).toBe(401)
  })

  it('registers a passkey and lists it', async () => {
    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/webauthn/register/begin', headers: authHeaders(owner), payload: {} })
    expect(begin.statusCode).toBe(200)
    const { challengeId, options } = begin.json()
    expect(options.challenge).toBeTruthy()

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/register/complete',
      headers: authHeaders(owner),
      payload: { challengeId, response: { id: 'cred-abc' }, deviceName: 'MacBook' },
    })
    expect(complete.statusCode).toBe(201)
    expect(complete.json().credential.device_name).toBe('MacBook')

    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/webauthn/credentials', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(list.json().credentials).toHaveLength(1)
  })

  it('binds challenges to the requesting user and consumes them once', async () => {
    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/webauthn/register/begin', headers: authHeaders(owner), payload: {} })
    const challengeId = begin.json().challengeId as string

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/register/complete',
      headers: authHeaders(analyst),
      payload: { challengeId, response: { id: 'cred-other' } },
    })
    expect(mismatch.statusCode).toBe(400)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/register/complete',
      headers: authHeaders(owner),
      payload: { challengeId, response: { id: 'cred-abc' } },
    })
    expect(replay.statusCode).toBe(400)
  })

  it('rejects bad passwords and reports accounts without passkeys', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/assert/begin',
      payload: { email: owner.email, password: 'not-the-password' },
    })
    expect(bad.statusCode).toBe(401)

    const none = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/assert/begin',
      payload: { email: analyst.email, password: 'member-password-12345' },
    })
    expect(none.statusCode).toBe(200)
    expect(none.json().available).toBe(false)
  })

  it('signs in with a passkey and updates the counter', async () => {
    const begin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/assert/begin',
      payload: { email: owner.email, password: 'correct-horse-battery-9' },
    })
    expect(begin.statusCode).toBe(200)
    expect(begin.json().available).toBe(true)
    const challengeId = begin.json().challengeId as string

    const complete = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/webauthn/assert/complete',
      payload: { challengeId, response: { id: 'cred-abc' } },
    })
    expect(complete.statusCode).toBe(200)
    expect(complete.json().accessToken).toBeTruthy()

    const counter = await app.db.query("SELECT counter, last_used_at FROM webauthn_credentials WHERE credential_id = 'cred-abc'")
    expect(Number(counter.rows[0].counter)).toBe(7)
    expect(counter.rows[0].last_used_at).toBeTruthy()
  })

  it('removes a passkey and clears the webauthn flag when none remain', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/auth/webauthn/credentials', headers: authHeaders(owner) })
    const credentialId = list.json().credentials[0].id as string

    const del = await app.inject({ method: 'DELETE', url: `/api/v1/auth/webauthn/credentials/${credentialId}`, headers: authHeaders(owner) })
    expect(del.statusCode).toBe(200)

    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/webauthn/credentials', headers: authHeaders(owner) })
    expect(after.json().credentials).toEqual([])

    const flag = await app.db.query('SELECT webauthn_enabled FROM users WHERE id = $1', [owner.userId])
    expect(flag.rows[0].webauthn_enabled).toBe(false)
  })
})
