import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('AI Level-1 agent remediations', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'AI Agent Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'AI Agent Foreign' })

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'ai-box', hostname: 'a-host', os: 'windows' },
    })
    deviceId = enrol.json().device.id as string
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC on read and manage', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/ai-agent/remediations', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/ai-agent/remediations', headers: authHeaders(analyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().remediations).toEqual([])

    const analystPropose = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-agent/remediations',
      headers: authHeaders(analyst),
      payload: { sourceType: 'device_alert', deviceId, kind: 'high_cpu' },
    })
    expect(analystPropose.statusCode).toBe(201)
  })

  it('proposes a bounded remediation from a device signal', async () => {
    const propose = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-agent/remediations',
      headers: authHeaders(owner),
      payload: { sourceType: 'device_alert', deviceId, kind: 'high_cpu' },
    })
    expect(propose.statusCode).toBe(201)
    const remediation = propose.json().remediation
    expect(remediation.status).toBe('proposed')
    expect(remediation.tool).toBe('restart_device')
    expect(remediation.tool_args.deviceId).toBe(deviceId)
    expect(remediation.rationale.length).toBeGreaterThan(0)
  })

  it('rejects a proposal for a device outside the tenant', async () => {
    const propose = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-agent/remediations',
      headers: authHeaders(foreign),
      payload: { sourceType: 'device_alert', deviceId, kind: 'high_cpu' },
    })
    expect(propose.statusCode).toBe(404)
  })

  it('approves a proposal, executes the bounded tool, and records a device action', async () => {
    const propose = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-agent/remediations',
      headers: authHeaders(owner),
      payload: { sourceType: 'device_alert', deviceId, kind: 'high_cpu' },
    })
    const id = propose.json().remediation.id as string

    // Analysts can propose but not approve.
    const analystApprove = await app.inject({ method: 'POST', url: `/api/v1/ai-agent/remediations/${id}/approve`, headers: authHeaders(analyst) })
    expect(analystApprove.statusCode).toBe(403)

    const approve = await app.inject({ method: 'POST', url: `/api/v1/ai-agent/remediations/${id}/approve`, headers: authHeaders(owner) })
    expect(approve.statusCode).toBe(200)
    const remediation = approve.json().remediation
    expect(remediation.status).toBe('executed')
    expect(remediation.executed_at).toBeTruthy()

    const actions = await app.inject({ method: 'GET', url: `/api/v1/devices/actions?deviceId=${deviceId}`, headers: authHeaders(owner) })
    expect(actions.statusCode).toBe(200)
    const action = (actions.json().actions as Array<{ action: string; payload: Record<string, unknown> }>).find((a) => a.payload?.aiRemediation === id)
    expect(action).toBeTruthy()
    expect(action!.action).toBe('restart')
  })

  it('denies a proposal without executing', async () => {
    const propose = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-agent/remediations',
      headers: authHeaders(owner),
      payload: { sourceType: 'device_alert', deviceId, kind: 'high_cpu' },
    })
    const id = propose.json().remediation.id as string

    const deny = await app.inject({ method: 'POST', url: `/api/v1/ai-agent/remediations/${id}/deny`, headers: authHeaders(owner) })
    expect(deny.statusCode).toBe(200)
    expect(deny.json().remediation.status).toBe('denied')

    // A denied proposal cannot be approved afterwards.
    const approve = await app.inject({ method: 'POST', url: `/api/v1/ai-agent/remediations/${id}/approve`, headers: authHeaders(owner) })
    expect(approve.statusCode).toBe(400)
  })

  it('isolates the queue between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/ai-agent/remediations', headers: authHeaders(foreign) })
    expect(foreignList.statusCode).toBe(200)
    expect(foreignList.json().remediations).toEqual([])
  })
})
