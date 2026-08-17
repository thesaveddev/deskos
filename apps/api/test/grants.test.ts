import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('JIT privileged access grants', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let approver: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string
  let grantId: string

  const futureExpiry = () => new Date(Date.now() + 3600_000).toISOString()

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Grants Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    approver = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'Grants Foreign' })

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'grants-box', hostname: 'g-host', os: 'windows' },
    })
    deviceId = enrol.json().device.id as string
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC on reading and approving', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/grants', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/grants', headers: authHeaders(analyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().grants).toEqual([])
  })

  it('walks the full lifecycle: request, approve, checkout, checkin, revoke', async () => {
    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/grants',
      headers: authHeaders(analyst),
      payload: { permission: 'remote.elevated', scopeType: 'tenant', reason: 'Server patching', expiresAt: futureExpiry() },
    })
    expect(req.statusCode).toBe(201)
    grantId = req.json().grant.id
    expect(req.json().grant.status).toBe('pending')
    expect(req.json().grant.subject_id).toBe(analyst.userId)

    // A requester cannot approve their own grant.
    const selfApprove = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/approve`, headers: authHeaders(analyst) })
    expect(selfApprove.statusCode).toBe(403)

    const approve = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/approve`, headers: authHeaders(approver) })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().grant.status).toBe('approved')

    const checkout = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/checkout`, headers: authHeaders(analyst) })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().grant.status).toBe('active')

    const checkin = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/checkin`, headers: authHeaders(analyst) })
    expect(checkin.statusCode).toBe(200)
    expect(checkin.json().grant.status).toBe('approved')

    const revoke = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/revoke`, headers: authHeaders(approver) })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json().grant.status).toBe('revoked')
  })

  it('grants JIT elevation for an otherwise non-elevated technician', async () => {
    // Without a grant, the analyst (no remote.elevated) is denied elevation.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, type: 'attended', permissions: ['view_screen', 'elevation'], reason: 'Patch' },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.denied_reason).toBe('elevation_not_allowed')

    // Request + approve + check out a tenant-scoped elevation grant.
    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/grants',
      headers: authHeaders(analyst),
      payload: { permission: 'remote.elevated', scopeType: 'tenant', reason: 'Patch', expiresAt: futureExpiry() },
    })
    const id = req.json().grant.id as string
    await app.inject({ method: 'POST', url: `/api/v1/grants/${id}/approve`, headers: authHeaders(approver) })
    await app.inject({ method: 'POST', url: `/api/v1/grants/${id}/checkout`, headers: authHeaders(analyst) })

    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, type: 'attended', permissions: ['view_screen', 'elevation'], reason: 'Patch' },
    })
    expect(allowed.statusCode).toBe(201)

    // Check the tenant-wide grant back in so later scope tests are isolated.
    await app.inject({ method: 'POST', url: `/api/v1/grants/${id}/checkin`, headers: authHeaders(analyst) })
  })

  it('rejects past expiries and device-scope mismatches', async () => {
    const past = await app.inject({
      method: 'POST',
      url: '/api/v1/grants',
      headers: authHeaders(analyst),
      payload: { permission: 'remote.elevated', scopeType: 'tenant', reason: 'x', expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    expect(past.statusCode).toBe(400)

    // A device-scoped grant for a different device does not grant elevation here.
    const otherRotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const otherEnrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: otherRotate.json().token, name: 'other-box', hostname: 'o-host', os: 'windows' },
    })
    const otherDeviceId = otherEnrol.json().device.id as string

    const req = await app.inject({
      method: 'POST',
      url: '/api/v1/grants',
      headers: authHeaders(analyst),
      payload: { permission: 'remote.elevated', scopeType: 'device', scopeId: otherDeviceId, reason: 'x', expiresAt: futureExpiry() },
    })
    const id = req.json().grant.id as string
    await app.inject({ method: 'POST', url: `/api/v1/grants/${id}/approve`, headers: authHeaders(approver) })
    await app.inject({ method: 'POST', url: `/api/v1/grants/${id}/checkout`, headers: authHeaders(analyst) })

    const mismatched = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, type: 'attended', permissions: ['view_screen', 'elevation'], reason: 'x' },
    })
    expect(mismatched.statusCode).toBe(403)
  })

  it('isolates grants between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/grants', headers: authHeaders(foreign) })
    expect(foreignList.json().grants).toEqual([])

    const foreignAct = await app.inject({ method: 'POST', url: `/api/v1/grants/${grantId}/revoke`, headers: authHeaders(foreign) })
    expect(foreignAct.statusCode).toBe(404)
  })
})
