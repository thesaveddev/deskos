import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('service catalogue & approvals', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Catalogue Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    foreignOwner = await signupOwner(app, { tenantName: 'Catalogue Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('analyst can list but cannot create services', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/services', headers: authHeaders(analyst) })
    expect(list.statusCode).toBe(200)

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(analyst),
      payload: { name: 'Nope' },
    })
    expect(create.statusCode).toBe(403)
  })

  let serviceId: string

  it('manager creates a service requiring approval', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(manager),
      payload: { name: 'VPN access', description: 'Grant remote VPN access', approvalRequired: true },
    })
    expect(res.statusCode).toBe(201)
    serviceId = res.json().service.id
    expect(res.json().service.approval_required).toBe(true)
  })

  it('requesting the service creates a pending approval for the default approver', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Request VPN access for contractor', type: 'service_request', serviceId },
    })
    expect(create.statusCode).toBe(201)
    const ticketId = create.json().ticket.id
    expect(create.json().ticket.service_id).toBe(serviceId)

    const approvals = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/approvals`,
      headers: authHeaders(manager),
    })
    expect(approvals.statusCode).toBe(200)
    expect(approvals.json().approvals).toHaveLength(1)
    expect(approvals.json().approvals[0].status).toBe('pending')

    // default approver is the first service_desk_manager (the manager)
    const mine = await app.inject({ method: 'GET', url: '/api/v1/approvals/mine', headers: authHeaders(manager) })
    expect(mine.json().approvals.length).toBe(1)
    return { ticketId, approvalId: approvals.json().approvals[0].id }
  })

  it('a non-approver cannot decide', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Request second VPN access', type: 'service_request', serviceId },
    })
    const ticketId = create.json().ticket.id
    const approvals = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/approvals`,
      headers: authHeaders(manager),
    })
    const approvalId = approvals.json().approvals[0].id

    const decide = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/approvals/${approvalId}/decide`,
      headers: authHeaders(owner),
      payload: { decision: 'approved' },
    })
    expect(decide.statusCode).toBe(403)
  })

  it('the approver can approve and the decision is recorded', async () => {
    const mine = await app.inject({ method: 'GET', url: '/api/v1/approvals/mine', headers: authHeaders(manager) })
    const approval = mine.json().approvals[0]
    const decide = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${approval.ticket_id}/approvals/${approval.id}/decide`,
      headers: authHeaders(manager),
      payload: { decision: 'approved', note: 'Looks good' },
    })
    expect(decide.statusCode).toBe(200)
    expect(decide.json().approval.status).toBe('approved')

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${approval.ticket_id}/approvals/${approval.id}/decide`,
      headers: authHeaders(manager),
      payload: { decision: 'rejected' },
    })
    expect(again.statusCode).toBe(400)
  })

  it('a service without approval does not create an approval', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(manager),
      payload: { name: 'Standard laptop', approvalRequired: false },
    })
    const noApprovalServiceId = create.json().service.id

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Request standard laptop', type: 'service_request', serviceId: noApprovalServiceId },
    })
    const approvals = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticket.json().ticket.id}/approvals`,
      headers: authHeaders(manager),
    })
    expect(approvals.json().approvals).toHaveLength(0)
  })

  it('linking a foreign service is rejected', async () => {
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: authHeaders(foreignOwner),
      payload: { name: 'Foreign service' },
    })
    const foreignServiceId = foreign.json().service.id

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(manager),
      payload: { subject: 'Cross tenant service', type: 'service_request', serviceId: foreignServiceId },
    })
    expect(res.statusCode).toBe(400)
  })

  it('services are tenant-isolated', async () => {
    const steal = await app.inject({ method: 'GET', url: `/api/v1/services/${serviceId}`, headers: authHeaders(foreignOwner) })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/services', headers: authHeaders(foreignOwner) })
    expect(list.json().services.map((s: { id: string }) => s.id)).not.toContain(serviceId)
  })

  it('manager deletes the service', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/services/${serviceId}`, headers: authHeaders(manager) })
    expect(res.statusCode).toBe(200)
  })
})
