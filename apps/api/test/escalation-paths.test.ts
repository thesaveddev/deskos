import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, uniqueEmail } from './helpers.js'

describe('escalation paths', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Escalation Paths Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates, lists, updates, and deletes an escalation path', async () => {
    const team = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: `Infra ${uniqueEmail('team').split('-').at(-1)?.split('@')[0]}` },
    })
    expect(team.statusCode).toBe(201)
    const teamId = team.json().team.id as string

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/escalation-paths',
      headers: authHeaders(owner),
      payload: { name: 'Desktop to Infrastructure', source_priority: ['p1', 'p2'], target_team_id: teamId, auto_assign: true },
    })
    expect(created.statusCode).toBe(201)
    const path = created.json().path
    expect(path.name).toBe('Desktop to Infrastructure')
    expect(path.target_team_id).toBe(teamId)
    expect(path.enabled).toBe(true)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/escalation-paths',
      headers: authHeaders(owner),
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().paths.some((p: { id: number }) => p.id === path.id)).toBe(true)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/escalation-paths/${path.id}`,
      headers: authHeaders(owner),
      payload: { name: 'Renamed path', enabled: false },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().path.name).toBe('Renamed path')
    expect(updated.json().path.enabled).toBe(false)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/escalation-paths/${path.id}`,
      headers: authHeaders(owner),
    })
    expect(removed.statusCode).toBe(200)

    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/v1/escalation-paths/${path.id}`,
      headers: authHeaders(owner),
    })
    expect(gone.statusCode).toBe(404)
  })

  it('requires a target team when creating a path', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/escalation-paths',
      headers: authHeaders(owner),
      payload: { name: 'No target' },
    })
    expect(res.statusCode).toBe(400)
  })
})
