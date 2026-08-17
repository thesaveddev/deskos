import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('problem & change management', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'P&C Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates a problem ticket with root cause and workaround in ext', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: {
        subject: 'Recurring VPN disconnects',
        type: 'problem',
        rootCause: 'MTU misconfiguration on the edge router',
        workaround: 'Force TCP transport for the VPN client',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ticket.type).toBe('problem')
    expect(res.json().ticket.ext).toEqual({
      rootCause: 'MTU misconfiguration on the edge router',
      workaround: 'Force TCP transport for the VPN client',
    })
  })

  it('creates a change ticket that requests approval and stores change fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: {
        subject: 'Upgrade edge router firmware',
        type: 'change',
        risk: 'high',
        implementationPlan: 'Stage firmware, reboot at 22:00',
        backoutPlan: 'Roll back to previous firmware image',
        scheduledAt: '2026-08-20T22:00:00Z',
      },
    })
    expect(res.statusCode).toBe(201)
    const ticket = res.json().ticket
    expect(ticket.type).toBe('change')
    expect(ticket.ext.risk).toBe('high')
    expect(ticket.ext.implementationPlan).toContain('firmware')

    // A change always creates a pending approval for the default approver.
    const approvals = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}/approvals`,
      headers: authHeaders(manager),
    })
    expect(approvals.json().approvals).toHaveLength(1)
    expect(approvals.json().approvals[0].status).toBe('pending')
  })

  it('updates problem ext fields (merge, not overwrite)', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Printer queue backlog', type: 'problem', rootCause: 'Spooler crash', workaround: 'Restart spooler' },
    })
    const id = create.json().ticket.id

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tickets/${id}`,
      headers: authHeaders(manager),
      payload: { rootCause: 'Driver memory leak' },
    })
    expect(update.statusCode).toBe(200)
    expect(update.json().ticket.ext).toEqual({ rootCause: 'Driver memory leak', workaround: 'Restart spooler' })
  })

  it('links a problem to incidents and lists the links', async () => {
    const problem = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Problem: VPN failures', type: 'problem' },
    })
    const problemId = problem.json().ticket.id

    const incident = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Incident: VPN down for user', type: 'incident' },
    })
    const incidentId = incident.json().ticket.id

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${problemId}/links`,
      headers: authHeaders(manager),
      payload: { linkType: 'caused_by', targetType: 'ticket', targetId: incidentId },
    })
    expect(link.statusCode).toBe(201)

    const links = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${problemId}/links`,
      headers: authHeaders(manager),
    })
    expect(links.json().links).toHaveLength(1)
    expect(links.json().links[0].target_number).toBe(incident.json().ticket.number)

    // Duplicate link is idempotent (no error, no duplicate row).
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${problemId}/links`,
      headers: authHeaders(manager),
      payload: { linkType: 'caused_by', targetType: 'ticket', targetId: incidentId },
    })
    expect(dup.statusCode).toBe(200)
    expect(dup.json().duplicate).toBe(true)

    const linkId = links.json().links[0].id
    const unlink = await app.inject({
      method: 'DELETE',
      url: `/api/v1/links/${linkId}`,
      headers: authHeaders(manager),
    })
    expect(unlink.statusCode).toBe(200)
  })

  it('rejects linking to a non-existent target', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Link target test', type: 'incident' },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.json().ticket.id}/links`,
      headers: authHeaders(manager),
      payload: { linkType: 'related', targetType: 'asset', targetId: '00000000-0000-4000-8000-000000000000' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a change raised by an analyst still requires approval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(analyst),
      payload: { subject: 'Patch DNS server', type: 'change', risk: 'low' },
    })
    expect(res.statusCode).toBe(201)
    const approvals = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${res.json().ticket.id}/approvals`,
      headers: authHeaders(manager),
    })
    expect(approvals.json().approvals).toHaveLength(1)
    expect(approvals.json().approvals[0].status).toBe('pending')
  })
})
