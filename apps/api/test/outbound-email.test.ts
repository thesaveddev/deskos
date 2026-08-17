import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('outbound email (SMTP reply-by-email)', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let requester: Awaited<ReturnType<typeof seedActiveMember>>

  const SMTP_ENV = {
    DESKOS_SMTP_HOST: 'smtp.test.local',
    DESKOS_SMTP_PORT: '587',
    DESKOS_SMTP_USER: 'relay-user',
    DESKOS_SMTP_PASS: 'relay-pass',
    DESKOS_SMTP_FROM: 'support@deskos.test',
    DESKOS_SMTP_JSON: 'true',
  }

  beforeAll(async () => {
    app = await createTestApp(SMTP_ENV)
    owner = await signupOwner(app, { tenantName: 'Mail Org' })
    requester = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  const mail = () => app.mailer.sent

  async function createTicket(subject: string): Promise<number> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(requester),
      payload: { subject, description: 'description here' },
    })
    expect(res.statusCode).toBe(201)
    return res.json().ticket.number as number
  }

  async function findTicketId(number: number): Promise<string> {
    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets?q=${number}`,
      headers: authHeaders(owner),
    })
    const match = list.json().tickets.find((t: { number: number }) => t.number === number)
    if (!match) throw new Error(`ticket #${number} not found`)
    return match.id
  }

  it('public technician reply sends an email to the requester', async () => {
    const number = await createTicket('Outbound reply test')
    const ticketId = await findTicketId(number)
    const before = mail().length

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'We are looking into this.', visibility: 'public' },
    })
    expect(res.statusCode).toBe(201)

    expect(mail().length).toBe(before + 1)
    const m = mail()[mail().length - 1]
    expect(m.to).toBe(requester.email)
    expect(m.subject).toContain(`[${number}]`)
    expect(m.subject).toMatch(/^Re:/)
    expect(m.text).toContain('We are looking into this.')
    expect(m.text).toContain(`Ticket #${number}`)
  })

  it('internal note sends no email', async () => {
    const number = await createTicket('Internal note mail test')
    const ticketId = await findTicketId(number)
    const before = mail().length

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'Deep internal debugging notes', visibility: 'internal' },
    })
    expect(res.statusCode).toBe(201)
    expect(mail().length).toBe(before)
  })

  it('resolving a ticket emails the requester', async () => {
    const number = await createTicket('Resolve mail test')
    const ticketId = await findTicketId(number)
    const before = mail().length

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/status`,
      headers: authHeaders(owner),
      payload: { status: 'resolved' },
    })
    expect(res.statusCode).toBe(200)

    expect(mail().length).toBe(before + 1)
    const m = mail()[mail().length - 1]
    expect(m.subject).toMatch(/^Resolved:/)
    expect(m.subject).toContain(`[${number}]`)
    expect(m.text).toContain('resolved')
  })

  it('requester also gets an in-app notification on public reply', async () => {
    const number = await createTicket('Notify test')
    const ticketId = await findTicketId(number)

    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'Notification please', visibility: 'public' },
    })

    const notifications = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: authHeaders(requester),
    })
    expect(notifications.statusCode).toBe(200)
    expect(notifications.json().notifications.length).toBeGreaterThanOrEqual(1)
    expect(notifications.json().notifications[0].kind).toBe('ticket.replied')
    expect(notifications.json().notifications[0].subject_id).toBe(ticketId)
  })
})

describe('outbound email with SMTP disabled', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let requester: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp() // no SMTP env → mailer disabled
    owner = await signupOwner(app, { tenantName: 'NoMail Org' })
    requester = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  it('ticket operations succeed without SMTP configured', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(requester),
      payload: { subject: 'No SMTP ticket' },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = (
      await app.inject({ method: 'GET', url: '/api/v1/tickets?q=No%20SMTP', headers: authHeaders(owner) })
    ).json().tickets[0].id as string

    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'Reply with no SMTP configured', visibility: 'public' },
    })
    expect(reply.statusCode).toBe(201)

    const resolve = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/status`,
      headers: authHeaders(owner),
      payload: { status: 'resolved' },
    })
    expect(resolve.statusCode).toBe(200)
    expect(app.mailer.sent).toHaveLength(0)
  })
})
