import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('major incidents', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let incidentId: string
  let incidentTicketId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Incident Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'Incident Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  async function createTicket(session: typeof owner, subject: string): Promise<{ id: string; number: number }> {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(session), payload: { subject, description: 'desc' } })
    expect(res.statusCode).toBe(201)
    return res.json().ticket as { id: string; number: number }
  }

  it('enforces RBAC: end users denied, analysts read-only', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/incidents', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const analystRead = await app.inject({ method: 'GET', url: '/api/v1/incidents', headers: authHeaders(analyst) })
    expect(analystRead.statusCode).toBe(200)
    expect(analystRead.json().incidents).toEqual([])

    const analystWrite = await app.inject({ method: 'POST', url: '/api/v1/incidents', headers: authHeaders(analyst), payload: { subject: 'Nope' } })
    expect(analystWrite.statusCode).toBe(403)
  })

  it('declares an incident and lists it with ticket linkage', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/incidents',
      headers: authHeaders(owner),
      payload: { subject: 'Exchange down', description: 'Mailbox access failing', severity: 'sev1' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    incidentId = body.incident.id
    incidentTicketId = body.ticketId
    expect(body.incident.severity).toBe('sev1')
    expect(body.incident.status).toBe('open')
    expect(body.incident.priority).toBe('p1')

    const list = await app.inject({ method: 'GET', url: '/api/v1/incidents', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const incidents = list.json().incidents as Array<{ id: string; severity: string; status: string }>
    expect(incidents).toHaveLength(1)
    expect(incidents[0].id).toBe(incidentId)
  })

  it('filters incidents by severity and status', async () => {
    const bySev = await app.inject({ method: 'GET', url: '/api/v1/incidents?severity=sev1', headers: authHeaders(owner) })
    expect(bySev.json().incidents).toHaveLength(1)

    const byStatus = await app.inject({ method: 'GET', url: '/api/v1/incidents?status=resolved', headers: authHeaders(owner) })
    expect(byStatus.json().incidents).toEqual([])
  })

  it('updates status and resolves the backing ticket', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/incidents/${incidentId}`,
      headers: authHeaders(owner),
      payload: { status: 'resolved', severity: 'sev2' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().incident.status).toBe('resolved')
    expect(patch.json().incident.severity).toBe('sev2')
    expect(patch.json().incident.resolved_at).toBeTruthy()

    const detail = await app.inject({ method: 'GET', url: `/api/v1/incidents/${incidentId}`, headers: authHeaders(owner) })
    expect(detail.json().incident.ticket_status).toBe('resolved')
  })

  it('bridges a ticket and deduplicates', async () => {
    const ticket = await createTicket(owner, 'Mailbox sync failure')
    const bridge = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/bridge`,
      headers: authHeaders(owner),
      payload: { targetTicketId: ticket.id },
    })
    expect(bridge.statusCode).toBe(201)
    expect(bridge.json().duplicate).toBe(false)

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/bridge`,
      headers: authHeaders(owner),
      payload: { targetTicketId: ticket.id },
    })
    expect(again.statusCode).toBe(201)
    expect(again.json().duplicate).toBe(true)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/incidents/${incidentId}`, headers: authHeaders(owner) })
    expect(detail.json().links).toHaveLength(1)
    expect(detail.json().links[0].target_number).toBe(ticket.number)
  })

  it('rejects foreign targets and isolates tenants', async () => {
    const foreignTicket = await createTicket(foreign, 'Foreign ticket')
    const badBridge = await app.inject({
      method: 'POST',
      url: `/api/v1/incidents/${incidentId}/bridge`,
      headers: authHeaders(owner),
      payload: { targetTicketId: foreignTicket.id },
    })
    expect(badBridge.statusCode).toBe(404)

    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/incidents', headers: authHeaders(foreign) })
    expect(foreignList.json().incidents).toEqual([])

    const foreignGet = await app.inject({ method: 'GET', url: `/api/v1/incidents/${incidentId}`, headers: authHeaders(foreign) })
    expect(foreignGet.statusCode).toBe(404)
  })
})
