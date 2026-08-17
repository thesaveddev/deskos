import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('patch management', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let engineer: Awaited<ReturnType<typeof seedActiveMember>>
  let approver: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string
  let deviceToken: string
  let patchId: string

  const sha = 'a'.repeat(64)

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Patches Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    engineer = await seedActiveMember(app, owner.tenantId!, 'infrastructure_engineer')
    approver = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'Patches Foreign' })

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'patch-box', hostname: 'p-host', os: 'windows' },
    })
    deviceId = enrol.json().device.id as string
    deviceToken = enrol.json().deviceToken as string
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC on read, manage, and approve', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/patches', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/patches', headers: authHeaders(analyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().patches).toEqual([])

    const analystWrite = await app.inject({ method: 'POST', url: '/api/v1/patches', headers: authHeaders(analyst), payload: { name: 'x', version: '1', artifactUrl: 'https://e.com/a.exe', sha256: sha } })
    expect(analystWrite.statusCode).toBe(403)
  })

  it('walks the approval lifecycle and assigns rings on start', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/patches',
      headers: authHeaders(owner),
      payload: {
        name: 'CrowdStrike sensor',
        version: '7.20.0',
        artifactUrl: 'https://example.com/cs-7.20.exe',
        sha256: sha,
        rings: [{ name: 'Ring 1', percent: 100 }],
      },
    })
    expect(create.statusCode).toBe(201)
    patchId = create.json().patch.id
    expect(create.json().patch.status).toBe('draft')

    // Engineer can submit but cannot approve.
    const submit = await app.inject({ method: 'POST', url: `/api/v1/patches/${patchId}/submit`, headers: authHeaders(engineer) })
    expect(submit.statusCode).toBe(200)
    expect(submit.json().patch.status).toBe('pending_approval')

    const engineerApprove = await app.inject({ method: 'POST', url: `/api/v1/patches/${patchId}/approve`, headers: authHeaders(engineer) })
    expect(engineerApprove.statusCode).toBe(403)

    const approve = await app.inject({ method: 'POST', url: `/api/v1/patches/${patchId}/approve`, headers: authHeaders(approver) })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().patch.status).toBe('approved')

    const start = await app.inject({ method: 'POST', url: `/api/v1/patches/${patchId}/start`, headers: authHeaders(owner) })
    expect(start.statusCode).toBe(200)
    expect(start.json().patch.status).toBe('rolling_out')

    const detail = await app.inject({ method: 'GET', url: `/api/v1/patches/${patchId}`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    const rings = detail.json().rings as Array<{ ring_index: number; status: string; n: number }>
    expect(rings).toHaveLength(1)
    expect(rings[0].ring_index).toBe(0)
    expect(rings[0].status).toBe('pending')
    expect(rings[0].n).toBe(1)
  })

  it('lets the agent list pending patches and report status', async () => {
    const pending = await app.inject({ method: 'GET', url: '/api/v1/agent/patches', headers: { authorization: `Bearer ${deviceToken}` } })
    expect(pending.statusCode).toBe(200)
    expect(pending.json().patches).toHaveLength(1)
    expect(pending.json().patches[0].id).toBe(patchId)

    const report = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/patches/${patchId}/status`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'succeeded' },
    })
    expect(report.statusCode).toBe(200)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/patches/${patchId}`, headers: authHeaders(owner) })
    const rings = detail.json().rings as Array<{ ring_index: number; status: string; n: number }>
    expect(rings[0].status).toBe('succeeded')
    expect(rings[0].n).toBe(1)
  })

  it('rolls back a rolling deployment', async () => {
    const rollback = await app.inject({ method: 'POST', url: `/api/v1/patches/${patchId}/rollback`, headers: authHeaders(owner) })
    expect(rollback.statusCode).toBe(200)
    expect(rollback.json().patch.status).toBe('rolled_back')

    const pending = await app.inject({ method: 'GET', url: '/api/v1/agent/patches', headers: { authorization: `Bearer ${deviceToken}` } })
    expect(pending.json().patches).toEqual([])
  })

  it('isolates patches between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/patches', headers: authHeaders(foreign) })
    expect(foreignList.json().patches).toEqual([])

    const foreignGet = await app.inject({ method: 'GET', url: `/api/v1/patches/${patchId}`, headers: authHeaders(foreign) })
    expect(foreignGet.statusCode).toBe(404)
  })
})
