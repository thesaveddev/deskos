import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('customer portal', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let requester: Awaited<ReturnType<typeof seedActiveMember>>
  let stranger: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Portal Org' })
    requester = await seedActiveMember(app, owner.tenantId!, 'end_user')
    stranger = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  let ticketNumber: number

  it('end user creates a ticket via the portal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(requester),
      payload: { subject: 'My screen flickers', description: 'It started this morning.' },
    })
    expect(res.statusCode).toBe(201)
    ticketNumber = res.json().ticket.number
    expect(ticketNumber).toBeGreaterThanOrEqual(1)
    expect(res.json().ticket.source).toBe('portal')
    expect(res.json().ticket.requester_id).toBe(requester.userId)
  })

  it('end user lists only their own tickets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/tickets', headers: authHeaders(requester) })
    expect(res.statusCode).toBe(200)
    const tickets = res.json().tickets
    expect(tickets).toHaveLength(1)
    expect(tickets[0].number).toBe(ticketNumber)

    const strangerList = await app.inject({ method: 'GET', url: '/api/v1/portal/tickets', headers: authHeaders(stranger) })
    expect(strangerList.json().tickets).toHaveLength(0)
  })

  it('end user cannot read someone else\'s ticket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/portal/tickets/${ticketNumber}`,
      headers: authHeaders(stranger),
    })
    expect(res.statusCode).toBe(404)
  })

  it('requester sees public thread but not internal notes', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${(await findTicketId(app, owner, ticketNumber))}`,
      headers: authHeaders(owner),
    })
    const ticketId = detail.json().ticket.id

    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'Internal diagnosis notes', visibility: 'internal' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'Please try updating the driver.', visibility: 'public' },
    })

    const portalView = await app.inject({
      method: 'GET',
      url: `/api/v1/portal/tickets/${ticketNumber}`,
      headers: authHeaders(requester),
    })
    expect(portalView.statusCode).toBe(200)
    const bodies = portalView.json().threads.map((t: { body: string }) => t.body)
    expect(bodies).toContain('Please try updating the driver.')
    expect(bodies).not.toContain('Internal diagnosis notes')
  })

  it('requester reply reopens pending_user tickets', async () => {
    const ticketId = await findTicketId(app, owner, ticketNumber)
    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/status`,
      headers: authHeaders(owner),
      payload: { status: 'pending_user' },
    })

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${ticketNumber}/reply`,
      headers: authHeaders(requester),
      payload: { body: 'Driver updated, still flickering.' },
    })
    expect(reply.statusCode).toBe(201)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: authHeaders(owner) })
    expect(detail.json().ticket.status).toBe('open')
  })

  it('stranger cannot resolve someone else\'s ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${ticketNumber}/resolve`,
      headers: authHeaders(stranger),
    })
    expect(res.statusCode).toBe(404)
  })

  it('requester resolves their own ticket from the portal (request loop closed)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${ticketNumber}/resolve`,
      headers: authHeaders(requester),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticket.status).toBe('resolved')
    expect(res.json().ticket.resolved_at).not.toBeNull()

    // second resolve is idempotent (204, no change)
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${ticketNumber}/resolve`,
      headers: authHeaders(requester),
    })
    expect(again.statusCode).toBe(204)

    // staff view reflects the resolution + system event
    const ticketId = await findTicketId(app, owner, ticketNumber)
    const staff = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: authHeaders(owner) })
    expect(staff.json().ticket.status).toBe('resolved')
    const eventBodies = staff.json().threads
      .filter((t: { kind: string }) => t.kind === 'system_event')
      .map((t: { body: string }) => t.body)
    expect(eventBodies).toContain('Requester marked the ticket as resolved')
  })

  it('requester can create a new ticket after resolving (fresh loop)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(requester),
      payload: { subject: 'Another request after resolve' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ticket.number).toBeGreaterThan(ticketNumber)
  })
})

async function findTicketId(app: FastifyInstance, owner: { accessToken: string }, number: number): Promise<string> {
  const list = await app.inject({
    method: 'GET',
    url: `/api/v1/tickets?q=${number}`,
    headers: { authorization: `Bearer ${owner.accessToken}` },
  })
  const match = list.json().tickets.find((t: { number: number }) => t.number === number)
  if (!match) throw new Error(`ticket #${number} not found`)
  return match.id
}
