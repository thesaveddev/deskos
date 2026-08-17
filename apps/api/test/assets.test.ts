import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('assets & licences', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Assets Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreignOwner = await signupOwner(app, { tenantName: 'Assets Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('end_user cannot read assets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('analyst can read but cannot create assets', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(analyst) })
    expect(list.statusCode).toBe(200)

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(analyst),
      payload: { tag: 'LT-001', type: 'hardware', name: 'Laptop' },
    })
    expect(create.statusCode).toBe(403)
  })

  let assetId: string

  it('manager creates an asset with an owner link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: {
        tag: 'LT-001',
        type: 'hardware',
        name: 'Engineering laptop',
        status: 'in_use',
        ownerId: analyst.userId,
        location: 'HQ-2F',
        supplier: 'Dell',
        warrantyUntil: '2027-01-01',
      },
    })
    expect(res.statusCode).toBe(201)
    assetId = res.json().asset.id
    expect(res.json().asset.tag).toBe('LT-001')
    expect(res.json().asset.owner_id).toBe(analyst.userId)
  })

  it('duplicate asset tag is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-001', type: 'hardware', name: 'Duplicate' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('owner must be a tenant member', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: { tag: 'LT-002', type: 'hardware', name: 'Bad owner', ownerId: foreignOwner.userId },
    })
    expect(res.statusCode).toBe(400)
  })

  it('linking a non-existent device is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: authHeaders(manager),
      payload: {
        tag: 'LT-003',
        type: 'hardware',
        name: 'Bad device',
        deviceId: '00000000-0000-4000-8000-000000000000',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('assets are searchable and filterable', async () => {
    const search = await app.inject({ method: 'GET', url: '/api/v1/assets?q=Engineering', headers: authHeaders(manager) })
    expect(search.json().assets.length).toBe(1)

    const filtered = await app.inject({ method: 'GET', url: '/api/v1/assets?type=hardware', headers: authHeaders(manager) })
    expect(filtered.json().assets.length).toBe(1)

    const none = await app.inject({ method: 'GET', url: '/api/v1/assets?type=mobile', headers: authHeaders(manager) })
    expect(none.json().assets).toHaveLength(0)
  })

  let licenceId: string

  it('manager creates a licence linked to the asset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/licences',
      headers: authHeaders(manager),
      payload: { assetId, name: 'Windows 11 Pro', keyRef: 'ref-123', seatsTotal: 25, seatsUsed: 10, expiresAt: '2027-06-30' },
    })
    expect(res.statusCode).toBe(201)
    licenceId = res.json().licence.id
    expect(res.json().licence.asset_id).toBe(assetId)
  })

  it('asset detail returns its licences', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${assetId}`, headers: authHeaders(manager) })
    expect(res.statusCode).toBe(200)
    expect(res.json().licences).toHaveLength(1)
    expect(res.json().licences[0].name).toBe('Windows 11 Pro')
  })

  it('manager updates a licence', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/licences/${licenceId}`,
      headers: authHeaders(manager),
      payload: { seatsUsed: 11 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().licence.seats_used).toBe(11)
  })

  it('assets and licences are tenant-isolated', async () => {
    const steal = await app.inject({ method: 'GET', url: `/api/v1/assets/${assetId}`, headers: authHeaders(foreignOwner) })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: authHeaders(foreignOwner) })
    expect(list.json().assets).toHaveLength(0)

    const licences = await app.inject({ method: 'GET', url: '/api/v1/licences', headers: authHeaders(foreignOwner) })
    expect(licences.json().licences).toHaveLength(0)
  })

  it('manager deletes the licence and asset', async () => {
    const delLicence = await app.inject({ method: 'DELETE', url: `/api/v1/licences/${licenceId}`, headers: authHeaders(manager) })
    expect(delLicence.statusCode).toBe(200)

    const delAsset = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${assetId}`, headers: authHeaders(manager) })
    expect(delAsset.statusCode).toBe(200)
  })
})
