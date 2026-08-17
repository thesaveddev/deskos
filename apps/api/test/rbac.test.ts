import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, uniqueEmail } from './helpers.js'

describe('RBAC', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let auditor: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app)
    const tenantId = owner.tenantId!
    analyst = await seedActiveMember(app, tenantId, 'analyst')
    auditor = await seedActiveMember(app, tenantId, 'auditor')
    endUser = await seedActiveMember(app, tenantId, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  const invitePayload = () => ({ email: uniqueEmail('invitee'), orgRole: 'analyst' })

  it('owner can invite members', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(owner),
      payload: invitePayload(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().orgRole).toBe('analyst')
  })

  it('analyst cannot invite members (missing member.manage)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(analyst),
      payload: invitePayload(),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.denied_reason).toBe('missing_permission')
  })

  it('analyst can list members (member.read)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/members', headers: authHeaders(analyst) })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().members)).toBe(true)
  })

  it('auditor can read but not manage members', async () => {
    const read = await app.inject({ method: 'GET', url: '/api/v1/members', headers: authHeaders(auditor) })
    expect(read.statusCode).toBe(200)
    const write = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(auditor),
      payload: invitePayload(),
    })
    expect(write.statusCode).toBe(403)
  })

  it('end_user cannot read members', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/members', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('cannot invite an owner directly', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(owner),
      payload: { email: uniqueEmail('owner-invitee'), orgRole: 'owner' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('owner_invite')
  })
})
