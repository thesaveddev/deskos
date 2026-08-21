import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('Developer API ecosystem', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Developer Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  it('serves a valid public OpenAPI 3.1 spec with no auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })
    expect(res.statusCode).toBe(200)

    const spec = res.json() as Record<string, unknown>
    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info).toMatchObject({ title: 'ReyDesk Public API' })

    const components = spec.components as Record<string, { securitySchemes: Record<string, unknown> }>
    expect(components.securitySchemes.bearerAuth).toBeTruthy()
    expect(components.securitySchemes.oauthClientCredentials).toBeTruthy()
    expect(components.securitySchemes.oauthAuthorizationCode).toBeTruthy()

    const paths = spec.paths as Record<string, unknown>
    expect(paths['/api/v1/oauth/token']).toBeTruthy()
    expect(paths['/api/v1/oauth/authorize']).toBeTruthy()
    expect(paths['/api/v1/public/tickets']).toBeTruthy()

    const scopes = (spec['x-deskos-scopes'] as Array<{ scope: string; permission: string; description: string }>) ?? []
    expect(scopes.map((s) => s.scope)).toContain('tickets:read')
    expect(scopes.map((s) => s.scope)).toContain('audit:read')
    expect(scopes.find((s) => s.scope === 'tickets:read')?.permission).toBe('ticket.read')
  })

  it('gates the developer overview on integration.read', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/developer/overview', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/developer/overview', headers: authHeaders(manager) })
    expect(allowed.statusCode).toBe(200)
  })

  it('returns a complete overview shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/developer/overview', headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(typeof body.baseUrl).toBe('string')
    expect((body.auth as { tokenUrl: string }).tokenUrl).toContain('/api/v1/oauth/token')
    expect((body.auth as { authorizeUrl: string }).authorizeUrl).toContain('/api/v1/oauth/authorize')
    expect((body.endpoints as unknown[]).length).toBeGreaterThan(0)
    const scopes = body.scopes as Array<{ scope: string; description: string }>
    expect(scopes.length).toBeGreaterThan(0)
    expect(scopes.every((s) => s.scope && s.description)).toBe(true)
  })
})
