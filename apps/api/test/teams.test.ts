import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, uniqueEmail } from './helpers.js'

describe('ticket teams', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Team UX Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates a team with an active member as lead and lists queue metadata', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: 'Service Desk', leadId: analyst.userId, memberIds: [analyst.userId], createChat: true },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().team.name).toBe('Service Desk')
    expect(created.json().team.lead_id).toBe(analyst.userId)
    expect(created.json().team.chat_room_name).toBe('Service Desk')
    expect(created.json().team.member_ids).toContain(analyst.userId)
    expect(created.json().team.accepts_tickets).toBe(true)

    const teamMembers = await app.inject({ method: 'GET', url: `/api/v1/teams/${created.json().team.id}/members`, headers: authHeaders(analyst) })
    expect(teamMembers.statusCode).toBe(200)
    expect(teamMembers.json().members.map((member: { user_id: string }) => member.user_id)).toContain(analyst.userId)

    const secondMember = await seedActiveMember(app, owner.tenantId!, 'desktop_engineer')
    const added = await app.inject({
      method: 'PUT',
      url: `/api/v1/teams/${created.json().team.id}/members`,
      headers: authHeaders(owner),
      payload: { userIds: [analyst.userId, secondMember.userId] },
    })
    expect(added.statusCode).toBe(200)
    expect(added.json().members.map((member: { user_id: string }) => member.user_id)).toContain(secondMember.userId)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/teams/${created.json().team.id}/members/${secondMember.userId}`,
      headers: authHeaders(owner),
    })
    expect(removed.statusCode).toBe(200)
    const afterRemoval = await app.inject({ method: 'GET', url: `/api/v1/teams/${created.json().team.id}/members`, headers: authHeaders(owner) })
    expect(afterRemoval.json().members.map((member: { user_id: string }) => member.user_id)).not.toContain(secondMember.userId)

    const listed = await app.inject({ method: 'GET', url: '/api/v1/teams', headers: authHeaders(owner) })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().teams[0].lead_name).toBe('analyst user')
    expect(listed.json().teams[0].open_ticket_count).toBe(0)
  })

  it('rejects an invalid lead and duplicate team name', async () => {
    const invalidLead = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: 'Invalid Lead Team', leadId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(invalidLead.statusCode).toBe(400)
    expect(invalidLead.json().error.code).toBe('invalid_team_lead')

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: 'Service Desk' },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('team_name_taken')
  })

  it('can disable ticket intake and prevents routing tickets to that team', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: `Chat Only ${uniqueEmail('team').split('-').at(-1)?.split('@')[0]}`, acceptsTickets: false },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().team.accepts_tickets).toBe(false)

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Must not route to chat-only team', teamId: created.json().team.id },
    })
    expect(ticket.statusCode).toBe(400)
    expect(ticket.json().error.code).toBe('team_not_accepting_tickets')

    const reenabled = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${created.json().team.id}`,
      headers: authHeaders(owner),
      payload: { acceptsTickets: true },
    })
    expect(reenabled.statusCode).toBe(200)
    expect(reenabled.json().team.accepts_tickets).toBe(true)
  })

  it('updates and deletes a team, while requiring member management permission', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: `Infrastructure ${uniqueEmail('team').split('-').at(-1)?.split('@')[0]}` },
    })
    const teamId = created.json().team.id as string

    const analystCreate = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(analyst),
      payload: { name: 'Analyst Team' },
    })
    expect(analystCreate.statusCode).toBe(403)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/teams/${teamId}`,
      headers: authHeaders(owner),
      payload: { name: 'Infrastructure', leadId: analyst.userId },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().team.name).toBe('Infrastructure')
    expect(updated.json().team.lead_id).toBe(analyst.userId)

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/teams/${teamId}`, headers: authHeaders(owner) })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().ok).toBe(true)
  })
})
