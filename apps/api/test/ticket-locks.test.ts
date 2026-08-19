import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('ticket locks', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let ticketId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Ticket locks' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Lock contention test', description: 'Verify one active editor.' },
    })
    expect(created.statusCode).toBe(201)
    ticketId = created.json().ticket.id
  })

  afterAll(async () => {
    await app.close()
  })

  it('claims and locks atomically when assigned to the current agent', async () => {
    const assigned = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: authHeaders(owner),
      payload: { assigneeId: owner.userId },
    })
    expect(assigned.statusCode).toBe(200)

    const lock = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(owner),
    })
    expect(lock.statusCode).toBe(200)
    expect(lock.json().is_mine).toBe(true)
    expect(lock.json().lock.locked_by).toBe(owner.userId)
  })

  it('rejects a competing claim and protects ticket writes', async () => {
    const claim = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(claim.statusCode).toBe(409)
    expect(claim.json().error.code).toBe('ticket_locked')
    expect(claim.json().error.details.locked_by).toBe(owner.userId)

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tickets/${ticketId}`,
      headers: authHeaders(analyst),
      payload: { subject: 'Should be blocked while locked' },
    })
    expect(update.statusCode).toBe(409)
    expect(update.json().error.code).toBe('ticket_locked')
  })

  it('allows an owner to force-unlock and then lets another agent claim', async () => {
    const denied = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tickets/${ticketId}/lock/force`,
      headers: authHeaders(analyst),
    })
    expect(denied.statusCode).toBe(403)

    const unlocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tickets/${ticketId}/lock/force`,
      headers: authHeaders(owner),
    })
    expect(unlocked.statusCode).toBe(200)

    const claim = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/assign`,
      headers: authHeaders(analyst),
      payload: { assigneeId: analyst.userId },
    })
    expect(claim.statusCode).toBe(200)

    const lock = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(lock.json().is_mine).toBe(true)

    const requested = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/lock/release-request`,
      headers: authHeaders(owner),
      payload: { message: 'Please release this ticket when finished.' },
    })
    expect(requested.statusCode).toBe(201)

    const approved = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/lock/release-requests/${requested.json().request.id}/resolve`,
      headers: authHeaders(analyst),
      payload: { decision: 'approve' },
    })
    expect(approved.statusCode).toBe(200)

    const afterApproval = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(afterApproval.json().lock).toBeNull()

    const reacquired = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(reacquired.statusCode).toBe(200)
  })

  it('releases only the current owner lock when leaving the ticket', async () => {
    const otherRelease = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(owner),
    })
    expect(otherRelease.statusCode).toBe(200)

    const stillLocked = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(stillLocked.json().is_mine).toBe(true)

    const release = await app.inject({
      method: 'DELETE',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(release.statusCode).toBe(200)

    const unlocked = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/lock`,
      headers: authHeaders(analyst),
    })
    expect(unlocked.json().lock).toBeNull()
  })
})
