import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('MSP multi-tenant switching', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Alpha' })
    ownerB = await signupOwner(app, { tenantName: 'Beta' })

    await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(ownerA),
      payload: { subject: 'Alpha ticket', description: 'desc' },
    })

    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(ownerB),
      payload: { email: ownerA.email, orgRole: 'analyst' },
    })
    expect(invite.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
  })

  it('reports every membership on /me', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeaders(ownerA) })
    expect(me.statusCode).toBe(200)
    expect(me.json().memberships).toHaveLength(2)
  })

  it('requires an explicit tenant when memberships are ambiguous', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(ownerA) })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('tenant_ambiguous')
  })

  it('scopes each request to the selected tenant', async () => {
    const alpha = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(ownerA, ownerA.tenantId!) })
    expect(alpha.statusCode).toBe(200)
    expect(alpha.json().tickets).toHaveLength(1)

    const beta = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(ownerA, ownerB.tenantId!) })
    expect(beta.statusCode).toBe(200)
    expect(beta.json().tickets).toHaveLength(0)
  })

  it('rejects a tenant the user does not belong to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tickets',
      headers: authHeaders(ownerA, '00000000-0000-0000-0000-000000000000'),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('permission_denied')
    expect(res.json().error.denied_reason).toBe('tenant_not_member')
  })
})
