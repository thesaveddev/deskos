import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('telephony', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let callId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Telephony Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'Telephony Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  async function createTicket(session: typeof owner, subject: string): Promise<{ id: string }> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(session), payload: { subject, description: 'desc' } })
    expect(res.statusCode).toBe(201)
    return res.json().ticket as { id: string }
  }

  it('enforces RBAC: end users denied, analysts read-only', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const analystRead = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls', headers: authHeaders(analyst) })
    expect(analystRead.statusCode).toBe(200)
    expect(analystRead.json().calls).toEqual([])

    const analystWrite = await app.inject({ method: 'POST', url: '/api/v1/telephony/calls', headers: authHeaders(analyst), payload: { direction: 'inbound' } })
    expect(analystWrite.statusCode).toBe(403)
  })

  it('logs a call and lists it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/telephony/calls',
      headers: authHeaders(owner),
      payload: { direction: 'inbound', fromNumber: '+15551234567', callerName: 'Alice', status: 'answered', durationSec: 320 },
    })
    expect(res.statusCode).toBe(201)
    callId = res.json().call.id

    const list = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const calls = list.json().calls as Array<{ from_number: string; caller_name: string }>
    expect(calls).toHaveLength(1)
    expect(calls[0].from_number).toBe('+15551234567')
    expect(calls[0].caller_name).toBe('Alice')
  })

  it('links a call to a ticket and rejects foreign tickets', async () => {
    const ticket = await createTicket(owner, 'Phone outage')
    const link = await app.inject({ method: 'PATCH', url: `/api/v1/telephony/calls/${callId}`, headers: authHeaders(owner), payload: { ticketId: ticket.id } })
    expect(link.statusCode).toBe(200)
    expect(link.json().call.ticket_id).toBe(ticket.id)

    const byTicket = await app.inject({ method: 'GET', url: `/api/v1/telephony/calls?ticketId=${ticket.id}`, headers: authHeaders(owner) })
    expect(byTicket.json().calls).toHaveLength(1)

    const foreignTicket = await createTicket(foreign, 'Foreign ticket')
    const badLink = await app.inject({ method: 'PATCH', url: `/api/v1/telephony/calls/${callId}`, headers: authHeaders(owner), payload: { ticketId: foreignTicket.id } })
    expect(badLink.statusCode).toBe(404)

    const clear = await app.inject({ method: 'PATCH', url: `/api/v1/telephony/calls/${callId}`, headers: authHeaders(owner), payload: { ticketId: null } })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().call.ticket_id).toBeNull()
  })

  it('filters and searches calls', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/telephony/calls',
      headers: authHeaders(owner),
      payload: { direction: 'outbound', toNumber: '+15559876543', callerName: 'Bob', status: 'missed', durationSec: 0 },
    })

    const byName = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls?q=Alice', headers: authHeaders(owner) })
    expect(byName.json().calls).toHaveLength(1)

    const byDirection = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls?direction=outbound', headers: authHeaders(owner) })
    expect(byDirection.json().calls).toHaveLength(1)
    expect(byDirection.json().calls[0].caller_name).toBe('Bob')

    const byStatus = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls?status=answered', headers: authHeaders(owner) })
    expect(byStatus.json().calls).toHaveLength(1)
  })

  it('isolates calls between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls', headers: authHeaders(foreign) })
    expect(foreignList.json().calls).toEqual([])

    const foreignLink = await app.inject({ method: 'PATCH', url: `/api/v1/telephony/calls/${callId}`, headers: authHeaders(foreign), payload: { ticketId: null } })
    expect(foreignLink.statusCode).toBe(404)
  })
})
