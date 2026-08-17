import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { evaluateConditions } from '../src/modules/automation/engine.js'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('automation rules', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Automation Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    foreignOwner = await signupOwner(app, { tenantName: 'Automation Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('analyst cannot read automations (no automation.read)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/automations', headers: authHeaders(analyst) })
    expect(res.statusCode).toBe(403)
  })

  it('evaluateConditions: all/any semantics', () => {
    const subject = { objectType: 'ticket' as const, objectId: 'x', fields: { priority: 'p1', source: 'portal', tags: ['vpn'] } }
    expect(evaluateConditions({ all: [{ field: 'priority', op: 'eq', value: 'p1' }] }, subject)).toBe(true)
    expect(evaluateConditions({ all: [{ field: 'priority', op: 'eq', value: 'p2' }] }, subject)).toBe(false)
    expect(evaluateConditions({ any: [{ field: 'priority', op: 'eq', value: 'p2' }, { field: 'source', op: 'eq', value: 'portal' }] }, subject)).toBe(true)
    expect(evaluateConditions({ all: [{ field: 'tags', op: 'contains', value: 'vpn' }] }, subject)).toBe(true)
    expect(evaluateConditions({ all: [{ field: 'priority', op: 'in', value: ['p1', 'p2'] }] }, subject)).toBe(true)
  })

  let automationId: string

  it('manager creates an automation that escalates p1 tickets', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automations',
      headers: authHeaders(manager),
      payload: {
        name: 'Escalate p1',
        trigger: 'ticket.created',
        conditions: { all: [{ field: 'priority', op: 'eq', value: 'p1' }] },
        actions: [
          { type: 'set_priority', priority: 'p1' },
          { type: 'add_tags', tags: ['automation', 'escalated'] },
          { type: 'add_note', body: 'Automation flagged priority {{priority}} ticket.' },
        ],
        enabled: true,
      },
    })
    expect(res.statusCode).toBe(201)
    automationId = res.json().automation.id
    expect(res.json().automation.trigger).toBe('ticket.created')
  })

  it('creating a p1 ticket triggers the rule (tags + note applied)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Critical VPN outage', priority: 'p1', description: 'down' },
    })
    expect(create.statusCode).toBe(201)
    const ticketId = create.json().ticket.id
    expect(create.json().ticket.tags).toContain('escalated')

    const get = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}`,
      headers: authHeaders(manager),
    })
    const threads = get.json().threads as Array<{ kind: string; body: string }>
    expect(threads.some((t) => t.kind === 'system_event' && t.body.includes('Automation flagged priority p1'))).toBe(true)
  })

  it('a p3 ticket does not match and records a skipped run', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Low priority request', priority: 'p3' },
    })
    expect(create.statusCode).toBe(201)
    expect(create.json().ticket.tags ?? []).not.toContain('escalated')

    const runs = await app.inject({
      method: 'GET',
      url: `/api/v1/automations/${automationId}/runs`,
      headers: authHeaders(manager),
    })
    expect(runs.statusCode).toBe(200)
    expect(runs.json().runs.length).toBe(2)
    const statuses = runs.json().runs.map((r: { status: string }) => r.status)
    expect(statuses).toContain('ok')
    expect(statuses).toContain('skipped')
  })

  it('manager can disable and re-enable the automation', async () => {
    const off = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/toggle`,
      headers: authHeaders(manager),
      payload: { enabled: false },
    })
    expect(off.statusCode).toBe(200)
    expect(off.json().automation.enabled).toBe(false)

    const on = await app.inject({
      method: 'POST',
      url: `/api/v1/automations/${automationId}/toggle`,
      headers: authHeaders(manager),
      payload: { enabled: true },
    })
    expect(on.json().automation.enabled).toBe(true)
  })

  it('automations are tenant-isolated', async () => {
    const steal = await app.inject({
      method: 'GET',
      url: `/api/v1/automations/${automationId}`,
      headers: authHeaders(foreignOwner),
    })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/automations', headers: authHeaders(foreignOwner) })
    expect(list.json().automations).toHaveLength(0)
  })

  it('manager deletes the automation', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/automations/${automationId}`,
      headers: authHeaders(manager),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
  })
})
