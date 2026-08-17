import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('script library', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let desktopEngineer: Awaited<ReturnType<typeof seedActiveMember>>
  let infraEngineer: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Scripts Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    desktopEngineer = await seedActiveMember(app, owner.tenantId!, 'desktop_engineer')
    infraEngineer = await seedActiveMember(app, owner.tenantId!, 'infrastructure_engineer')
    foreignOwner = await signupOwner(app, { tenantName: 'Scripts Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('analyst cannot read scripts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/scripts', headers: authHeaders(analyst) })
    expect(res.statusCode).toBe(403)
  })

  it('desktop engineer can read but not author scripts', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/scripts', headers: authHeaders(desktopEngineer) })
    expect(list.statusCode).toBe(200)

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/scripts',
      headers: authHeaders(desktopEngineer),
      payload: { name: 'Nope' },
    })
    expect(create.statusCode).toBe(403)
  })

  let scriptId: string

  it('manager authors a script as a draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scripts',
      headers: authHeaders(manager),
      payload: { name: 'Flush DNS', category: 'network', os: ['windows'], body: 'ipconfig /flushdns', privilegeLevel: 'user' },
    })
    expect(res.statusCode).toBe(201)
    scriptId = res.json().script.id
    expect(res.json().script.approval_status).toBe('draft')
    expect(res.json().script.version).toBe(1)
  })

  it('a draft script cannot run', async () => {
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${scriptId}/run`,
      headers: authHeaders(desktopEngineer),
      payload: {},
    })
    expect(run.statusCode).toBe(400)
  })

  it('manager submits for approval, then approves', async () => {
    const submit = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${scriptId}/submit`,
      headers: authHeaders(manager),
      payload: {},
    })
    expect(submit.statusCode).toBe(200)
    expect(submit.json().script.approval_status).toBe('pending')

    const approve = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${scriptId}/approve`,
      headers: authHeaders(manager),
      payload: {},
    })
    expect(approve.statusCode).toBe(200)
    expect(approve.json().script.approval_status).toBe('approved')
  })

  it('an approved user-level script can run and records a run', async () => {
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${scriptId}/run`,
      headers: authHeaders(desktopEngineer),
      payload: { args: { dns: '8.8.8.8' } },
    })
    expect(run.statusCode).toBe(201)
    expect(run.json().run.exit_code).toBeNull()

    const runs = await app.inject({
      method: 'GET',
      url: `/api/v1/scripts/${scriptId}/runs`,
      headers: authHeaders(desktopEngineer),
    })
    expect(runs.json().runs).toHaveLength(1)
  })

  it('body edits bump the version and reset approval to draft', async () => {
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/scripts/${scriptId}`,
      headers: authHeaders(manager),
      payload: { body: 'ipconfig /flushdns && ipconfig /registerdns' },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json().script.version).toBe(2)
    expect(update.json().script.approval_status).toBe('draft')
  })

  it('elevated scripts require remote.elevated to run', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/scripts',
      headers: authHeaders(manager),
      payload: { name: 'Elevated repair', category: 'system', os: ['windows'], body: 'sfc /scannow', privilegeLevel: 'elevated' },
    })
    const id = create.json().script.id
    await app.inject({ method: 'POST', url: `/api/v1/scripts/${id}/submit`, headers: authHeaders(manager), payload: {} })
    await app.inject({ method: 'POST', url: `/api/v1/scripts/${id}/approve`, headers: authHeaders(manager), payload: {} })

    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${id}/run`,
      headers: authHeaders(desktopEngineer),
      payload: {},
    })
    expect(denied.statusCode).toBe(403)

    const allowed = await app.inject({
      method: 'POST',
      url: `/api/v1/scripts/${id}/run`,
      headers: authHeaders(infraEngineer),
      payload: {},
    })
    expect(allowed.statusCode).toBe(201)
  })

  it('scripts are tenant-isolated', async () => {
    const steal = await app.inject({ method: 'GET', url: `/api/v1/scripts/${scriptId}`, headers: authHeaders(foreignOwner) })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/scripts', headers: authHeaders(foreignOwner) })
    expect(list.json().scripts).toHaveLength(0)
  })
})
