import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('MSP console and per-customer branding', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Alpha MSP' })
    ownerB = await signupOwner(app, { tenantName: 'Beta MSP' })

    // Alpha has one open ticket; Beta is empty.
    await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(ownerA),
      payload: { subject: 'Alpha ticket', description: 'desc' },
    })

    // ownerA is also an analyst in Beta (multi-tenant MSP technician).
    const invite = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(ownerB),
      payload: { email: ownerA.email, orgRole: 'analyst' },
    })
    expect(invite.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
  })

  it('lists every staff membership with per-tenant stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/msp/console', headers: authHeaders(ownerA) })
    expect(res.statusCode).toBe(200)
    const tenants = res.json().tenants as Array<{ name: string; orgRole: string; stats: { openTickets: number } }>
    expect(tenants).toHaveLength(2)
    const alpha = tenants.find((t) => t.name === 'Alpha MSP')!
    const beta = tenants.find((t) => t.name === 'Beta MSP')!
    expect(alpha.orgRole).toBe('owner')
    expect(alpha.stats.openTickets).toBe(1)
    expect(beta.orgRole).toBe('analyst')
    expect(beta.stats.openTickets).toBe(0)
  })

  it('excludes end-user memberships from the console', async () => {
    const endUser = await seedActiveMember(app, ownerA.tenantId!, 'end_user')
    const res = await app.inject({ method: 'GET', url: '/api/v1/msp/console', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(200)
    expect(res.json().tenants).toEqual([])
  })

  it('updates branding as owner and surfaces it via /me', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/branding',
      headers: authHeaders(ownerA, ownerA.tenantId!),
      payload: { portalTitle: 'Alpha Help', primaryColor: '#ff8800', logoUrl: 'https://example.com/logo.png' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().branding.portalTitle).toBe('Alpha Help')
    expect(patch.json().branding.primaryColor).toBe('#ff8800')

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeaders(ownerA) })
    const alphaMembership = me.json().memberships.find((m: { tenant: { name: string } }) => m.tenant.name === 'Alpha MSP')
    expect(alphaMembership.tenant.branding.portalTitle).toBe('Alpha Help')
    expect(alphaMembership.tenant.branding.primaryColor).toBe('#ff8800')
  })

  it('rejects branding changes without tenant.manage', async () => {
    // ownerA is only an analyst in Beta, so no tenant.manage there.
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/branding',
      headers: authHeaders(ownerA, ownerB.tenantId!),
      payload: { portalTitle: 'Nope' },
    })
    expect(denied.statusCode).toBe(403)
  })

  it('validates branding fields', async () => {
    const badColor = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/branding',
      headers: authHeaders(ownerA, ownerA.tenantId!),
      payload: { primaryColor: 'red' },
    })
    expect(badColor.statusCode).toBe(400)

    const badUrl = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/branding',
      headers: authHeaders(ownerA, ownerA.tenantId!),
      payload: { logoUrl: 'not-a-url' },
    })
    expect(badUrl.statusCode).toBe(400)
  })

  it('isolates branding between tenants', async () => {
    // Beta sees no branding until set, and never sees Alpha's branding.
    const betaConsole = await app.inject({ method: 'GET', url: '/api/v1/msp/console', headers: authHeaders(ownerB) })
    const betaEntry = betaConsole.json().tenants.find((t: { name: string }) => t.name === 'Beta MSP')
    expect(betaEntry.branding).toEqual({})

    const me = await app.inject({ method: 'GET', url: '/api/v1/me', headers: authHeaders(ownerB) })
    const betaMembership = me.json().memberships.find((m: { tenant: { name: string } }) => m.tenant.name === 'Beta MSP')
    expect(betaMembership.tenant.branding).toEqual({})
  })
})
