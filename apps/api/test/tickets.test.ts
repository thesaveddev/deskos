import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { authHeaders, createTestApp, getDatabaseUrl, seedActiveMember, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

describe('tickets', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let otherOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Tickets Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    otherOwner = await signupOwner(app, { tenantName: 'Other Tickets Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  const createTicket = async (session: typeof owner, subject: string, extra: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(session),
      payload: { subject, description: `${subject} — description`, ...extra },
    })
    expect(res.statusCode).toBe(201)
    return res.json().ticket
  }

  it('creates a ticket with number, deadlines and an opening thread', async () => {
    const ticket = await createTicket(owner, 'VPN keeps disconnecting', { priority: 'p2' })
    expect(ticket.number).toBe(1)
    expect(ticket.status).toBe('new')
    expect(ticket.priority).toBe('p2')
    expect(ticket.due_response_at).toBeTruthy()
    expect(ticket.due_resolution_at).toBeTruthy()
    expect(new Date(ticket.due_response_at).getTime()).toBeLessThan(new Date(ticket.due_resolution_at).getTime())

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    const body = detail.json()
    expect(body.threads).toHaveLength(1)
    expect(body.threads[0].kind).toBe('message')
  })

  it('increments ticket numbers per tenant', async () => {
    const second = await createTicket(owner, 'Second issue')
    expect(second.number).toBe(2)
  })

  it('links tickets to tenant devices and returns device context', async () => {
    const deviceId = await withTenant(app.db, owner.tenantId!, (client) =>
      client
        .query(
          `INSERT INTO devices (tenant_id, name, hostname, os, os_version)
           VALUES ($1, 'ticket-box', 'ticket-host', 'linux', '24.04')
           RETURNING id`,
          [owner.tenantId],
        )
        .then((r) => r.rows[0].id as string),
    )
    const ticket = await createTicket(owner, 'Device-linked issue', { deviceId })
    expect(ticket.device_id).toBe(deviceId)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().device.id).toBe(deviceId)
    expect(detail.json().device.name).toBe('ticket-box')
  })

  it('rejects linking a ticket to a device from another tenant', async () => {
    const deviceId = await withTenant(app.db, owner.tenantId!, (client) =>
      client
        .query(`INSERT INTO devices (tenant_id, name) VALUES ($1, 'private-box') RETURNING id`, [owner.tenantId])
        .then((r) => r.rows[0].id as string),
    )
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(otherOwner),
      payload: { subject: 'Cross-tenant device link', deviceId },
    })
    expect(res.statusCode).toBe(404)
  })

  it('lists tickets with filters', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(owner) })
    expect(all.statusCode).toBe(200)
    expect(all.json().tickets.length).toBeGreaterThanOrEqual(2)

    const mine = await app.inject({ method: 'GET', url: '/api/v1/tickets?assignee=me', headers: authHeaders(analyst) })
    expect(mine.statusCode).toBe(200)
    expect(mine.json().tickets).toHaveLength(0)
  })

  it('public reply sets first response and moves new → open', async () => {
    const ticket = await createTicket(owner, 'Printer offline')
    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/reply`,
      headers: authHeaders(analyst),
      payload: { body: 'Looking into this now.', visibility: 'public' },
    })
    expect(reply.statusCode).toBe(201)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}`, headers: authHeaders(owner) })
    const body = detail.json()
    expect(body.ticket.first_response_at).toBeTruthy()
    expect(body.ticket.status).toBe('open')
    const kinds = body.threads.map((t: { kind: string }) => t.kind)
    expect(kinds).toContain('system_event')
  })

  it('internal notes stay internal', async () => {
    const ticket = await createTicket(owner, 'Slow laptop')
    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/reply`,
      headers: authHeaders(analyst),
      payload: { body: 'Checked device health first.', visibility: 'internal' },
    })
    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}`, headers: authHeaders(owner) })
    const note = detail.json().threads.find((t: { kind: string }) => t.kind === 'internal_note')
    expect(note).toBeTruthy()
    expect(note.visibility).toBe('internal')
    const firstResponse = detail.json().ticket.first_response_at
    expect(firstResponse).toBeNull()
  })

  it('resolves and reopens with timestamps', async () => {
    const ticket = await createTicket(owner, 'Access request')
    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/status`,
      headers: authHeaders(owner),
      payload: { status: 'resolved' },
    })
    expect(resolve.statusCode).toBe(200)
    expect(resolve.json().ticket.resolved_at).toBeTruthy()

    const reopen = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/status`,
      headers: authHeaders(owner),
      payload: { status: 'open' },
    })
    expect(reopen.json().ticket.resolved_at).toBeNull()
  })

  it('assigns tickets', async () => {
    const ticket = await createTicket(owner, 'Assign me')
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticket.id}/assign`,
      headers: authHeaders(owner),
      payload: { assigneeId: analyst.userId },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticket.assignee_id).toBe(analyst.userId)

    const mine = await app.inject({ method: 'GET', url: '/api/v1/tickets?assignee=me', headers: authHeaders(analyst) })
    expect(mine.json().tickets.some((t: { id: string }) => t.id === ticket.id)).toBe(true)
  })

  it('updates fields and records the change', async () => {
    const ticket = await createTicket(owner, 'Escalate me')
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/tickets/${ticket.id}`,
      headers: authHeaders(owner),
      payload: { priority: 'p1', tags: ['vpn', 'network'] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ticket.priority).toBe('p1')

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}`, headers: authHeaders(owner) })
    const updated = detail.json().threads.find((t: { body: string }) => t.body === 'Ticket updated')
    expect(updated).toBeTruthy()
    expect(updated.meta.changes.priority.to).toBe('p1')
  })

  it('end_user cannot use staff ticket routes', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(endUser),
      payload: { subject: 'Should be denied' },
    })
    expect(create.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(endUser) })
    expect(list.statusCode).toBe(403)
  })

  it('exports tickets as CSV', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets/export.csv', headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    const lines = res.body.split('\n')
    expect(lines[0]).toBe('number,type,status,priority,subject,requester,assignee,created_at,resolved_at')
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('search finds tickets and users', async () => {
    const ticketHit = await app.inject({ method: 'GET', url: '/api/v1/search?q=VPN', headers: authHeaders(owner) })
    expect(ticketHit.statusCode).toBe(200)
    expect(ticketHit.json().tickets.length).toBeGreaterThanOrEqual(1)

    const userHit = await app.inject({ method: 'GET', url: '/api/v1/search?q=Test%20Owner', headers: authHeaders(owner) })
    expect(userHit.statusCode).toBe(200)
    expect(userHit.json().users.length).toBeGreaterThanOrEqual(1)
  })

  it('denies cross-tenant ticket access at API and DB level', async () => {
    const ticket = await createTicket(owner, 'Isolated ticket')

    const crossHeader = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticket.id}`,
      headers: authHeaders(otherOwner, owner.tenantSlug),
    })
    expect(crossHeader.statusCode).toBe(403)

    const client = new pg.Client({ connectionString: getDatabaseUrl() })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [otherOwner.tenantId])
      const { rows } = await client.query('SELECT count(*)::int AS n FROM tickets WHERE id = $1', [ticket.id])
      await client.query('COMMIT')
      expect(rows[0].n).toBe(0)
    } finally {
      await client.end()
    }
  })

  it('tenant counters are independent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(otherOwner),
      payload: { subject: 'First ticket in other org' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().ticket.number).toBe(1)
  })
})
