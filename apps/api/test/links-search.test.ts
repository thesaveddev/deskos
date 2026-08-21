import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('ticket link target search', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Link Search Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('finds tickets by subject and number for the linking dropdown', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'VPN disconnects for finance team' },
    })
    expect(created.statusCode).toBe(201)
    const number = created.json().ticket.number

    const bySubject = await app.inject({ method: 'GET', url: '/api/v1/links/search?type=ticket&q=VPN', headers: authHeaders(owner) })
    expect(bySubject.statusCode).toBe(200)
    const hit = bySubject.json().results.find((r: { id: string }) => r.id === created.json().ticket.id)
    expect(hit).toBeTruthy()
    expect(hit.type).toBe('ticket')
    expect(hit.label).toContain('VPN')

    const byNumber = await app.inject({ method: 'GET', url: `/api/v1/links/search?type=ticket&q=${number}`, headers: authHeaders(owner) })
    expect(byNumber.json().results.some((r: { id: string }) => r.id === created.json().ticket.id)).toBe(true)
  })

  it('returns empty results for short queries and unknown asset text', async () => {
    const short = await app.inject({ method: 'GET', url: '/api/v1/links/search?type=ticket&q=', headers: authHeaders(owner) })
    expect(short.statusCode).toBe(200)
    expect(short.json().results).toEqual([])

    const asset = await app.inject({ method: 'GET', url: '/api/v1/links/search?type=asset&q=does-not-exist', headers: authHeaders(owner) })
    expect(asset.statusCode).toBe(200)
    expect(asset.json().results).toEqual([])
  })
})
