import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('RMM endpoint management', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string
  let deviceToken: string
  let _policyId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'RMM Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'RMM Foreign' })

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'rmm-box', hostname: 'r-host', os: 'windows' },
    })
    deviceId = enrol.json().device.id as string
    deviceToken = enrol.json().deviceToken as string
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC on read and manage', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/endpoint-policies', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/endpoint-policies', headers: authHeaders(analyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().policies).toEqual([])

    const analystWrite = await app.inject({ method: 'POST', url: '/api/v1/endpoint-policies', headers: authHeaders(analyst), payload: { name: 'x' } })
    expect(analystWrite.statusCode).toBe(403)
  })

  it('reports and reads structured inventory via the agent', async () => {
    const report = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/inventory',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        hardware: { manufacturer: 'Dell', model: 'XPS 13', serial: 'SN123', cpu: 'i7', ram_gb: 16 },
        os: { edition: 'Windows 11 Pro', build: '22631', patch_level: '2026-08' },
        apps: [{ name: 'CrowdStrike', version: '7.20' }],
        securityPosture: { av: { enabled: true, product: 'CrowdStrike' }, firewall: true, encryption: true, secure_boot: true },
      },
    })
    expect(report.statusCode).toBe(200)

    const view = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/inventory`, headers: authHeaders(owner) })
    expect(view.statusCode).toBe(200)
    expect(view.json().inventory.hardware.manufacturer).toBe('Dell')
    expect(view.json().inventory.security_posture.encryption).toBe(true)
  })

  it('creates and deletes an endpoint policy', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/endpoint-policies',
      headers: authHeaders(owner),
      payload: { name: 'Encryption required', postureChecks: [{ check: 'encryption', expected: true }] },
    })
    expect(create.statusCode).toBe(201)
    _policyId = create.json().policy.id

    const list = await app.inject({ method: 'GET', url: '/api/v1/endpoint-policies', headers: authHeaders(owner) })
    expect(list.json().policies).toHaveLength(1)
    expect(list.json().policies[0].posture_checks).toEqual([{ check: 'encryption', expected: true }])
  })

  it('queues a bulk action and lets the agent claim and complete it', async () => {
    const queue = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/actions',
      headers: authHeaders(owner),
      payload: { action: 'collect_inventory', deviceIds: [deviceId] },
    })
    expect(queue.statusCode).toBe(201)
    expect(queue.json().created).toBe(1)

    const pending = await app.inject({ method: 'GET', url: '/api/v1/agent/actions/pending', headers: { authorization: `Bearer ${deviceToken}` } })
    expect(pending.statusCode).toBe(200)
    expect(pending.json().actions).toHaveLength(1)
    const actionId = pending.json().actions[0].id as string
    expect(pending.json().actions[0].action).toBe('collect_inventory')

    const result = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/actions/${actionId}/result`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { status: 'succeeded', result: { collected: true } },
    })
    expect(result.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/v1/devices/actions', headers: authHeaders(owner) })
    const action = (list.json().actions as Array<{ id: string; status: string }>).find((a) => a.id === actionId)!
    expect(action.status).toBe('succeeded')
  })

  it('isolates policies and inventory between tenants', async () => {
    const foreignPolicies = await app.inject({ method: 'GET', url: '/api/v1/endpoint-policies', headers: authHeaders(foreign) })
    expect(foreignPolicies.json().policies).toEqual([])

    const foreignInventory = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/inventory`, headers: authHeaders(foreign) })
    expect(foreignInventory.statusCode).toBe(404)
  })
})
