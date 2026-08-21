import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { applyAutoEscalationsForTenant } from '../src/modules/tickets/escalation.scheduler.js'

describe('escalation policies', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Escalation Policies Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates, lists, updates, and deletes an escalation policy', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/escalation-policies',
      headers: authHeaders(owner),
      payload: { name: 'Stuck open tickets', source_status: 'open', target_status: 'escalated', trigger_after_minutes: 30, trigger_on_priority: ['p1'], auto_assign: true },
    })
    expect(created.statusCode).toBe(201)
    const policy = created.json().policy
    expect(policy.name).toBe('Stuck open tickets')
    expect(policy.source_status).toBe('open')
    expect(policy.enabled).toBe(true)

    const listed = await app.inject({ method: 'GET', url: '/api/v1/escalation-policies', headers: authHeaders(owner) })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().policies.some((p: { id: number }) => p.id === policy.id)).toBe(true)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/escalation-policies/${policy.id}`,
      headers: authHeaders(owner),
      payload: { name: 'Renamed policy', enabled: false },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().policy.name).toBe('Renamed policy')
    expect(updated.json().policy.enabled).toBe(false)

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/escalation-policies/${policy.id}`, headers: authHeaders(owner) })
    expect(removed.statusCode).toBe(200)

    const gone = await app.inject({ method: 'DELETE', url: `/api/v1/escalation-policies/${policy.id}`, headers: authHeaders(owner) })
    expect(gone.statusCode).toBe(404)
  })

  it('auto-escalates a ticket that has breached its policy threshold', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Stuck incident', description: 'waiting on a fix' },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().ticket.id as string

    // Age the ticket so the policy sees it as stuck in its source status.
    await withTenant(app.db, owner.tenantId!, async (client) => {
      await client.query(
        `UPDATE tickets SET status = 'open', created_at = now() - interval '3 hours' WHERE id = $1`,
        [ticketId],
      )
    })

    const policy = await app.inject({
      method: 'POST',
      url: '/api/v1/escalation-policies',
      headers: authHeaders(owner),
      payload: { name: 'Open too long', source_status: 'open', target_status: 'escalated', trigger_after_minutes: 60, auto_assign: false, enabled: true },
    })
    expect(policy.statusCode).toBe(201)

    const applied = await applyAutoEscalationsForTenant(app.db, owner.tenantId!)
    expect(applied).toBeGreaterThanOrEqual(1)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: authHeaders(owner) })
    expect(detail.json().ticket.status).toBe('escalated')

    const escalations = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}/escalations`, headers: authHeaders(owner) })
    expect(escalations.json().escalations.some((e: { reason: string }) => e.reason === 'Auto: Open too long')).toBe(true)
  })

  it('returns the escalation paths that match a ticket', async () => {
    const team = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: `L2 ${Date.now()}` },
    })
    expect(team.statusCode).toBe(201)
    const teamId = team.json().team.id as string

    const path = await app.inject({
      method: 'POST',
      url: '/api/v1/escalation-paths',
      headers: authHeaders(owner),
      payload: { name: 'P1 to L2', source_priority: ['p1'], target_team_id: teamId, auto_assign: false },
    })
    expect(path.statusCode).toBe(201)

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Urgent outage', description: 'p1 issue', priority: 'p1' },
    })
    expect(ticket.statusCode).toBe(201)
    const ticketId = ticket.json().ticket.id as string

    const matches = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}/escalation-paths`, headers: authHeaders(owner) })
    expect(matches.statusCode).toBe(200)
    expect(matches.json().paths.some((p: { id: number }) => p.id === path.json().path.id)).toBe(true)
  })
})
