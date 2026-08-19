import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, uniqueEmail } from './helpers.js'

describe('team ticket acceptance policy', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Team Ticket Policy Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('allows non-ticket teams while rejecting ticket routing to them', async () => {
    const team = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: `Chat only ${uniqueEmail('team').split('-').at(-1)?.split('@')[0]}`, acceptsTickets: false },
    })

    expect(team.statusCode).toBe(201)
    expect(team.json().team.accepts_tickets).toBe(false)

    const rejected = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Should use another team', teamId: team.json().team.id },
    })

    expect(rejected.statusCode).toBe(400)
    expect(rejected.json().error.code).toBe('team_not_accepting_tickets')

  })
})
