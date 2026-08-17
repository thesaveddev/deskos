import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner, seedActiveMember, authHeaders } from './helpers.js'

describe('tenant settings', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Settings A' })
    ownerB = await signupOwner(app, { tenantName: 'Settings B' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('reads tenant basic settings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tenant.name).toBe('Settings A')
    expect(body.tenant.slug).toBe(ownerA.tenantSlug)
    expect(body.membership.orgRole).toBe('owner')
  })

  it('updates tenant name, slug, and region', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { name: 'Settings A Renamed', slug: `${ownerA.tenantSlug}-v2`, region: 'eu-west' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.tenant.name).toBe('Settings A Renamed')
    expect(body.tenant.slug).toBe(`${ownerA.tenantSlug}-v2`)
    expect(body.tenant.region).toBe('eu-west')

    const again = await app.inject({ method: 'GET', url: '/api/v1/tenant', headers: authHeaders(ownerA) })
    expect(again.json().tenant.name).toBe('Settings A Renamed')
  })

  it('rejects a slug already used by another tenant', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { slug: ownerB.tenantSlug },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('slug_taken')
  })

  it('rejects invalid slugs and empty names', async () => {
    const badSlug = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { slug: 'Bad Slug!' },
    })
    expect(badSlug.statusCode).toBe(400)

    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { name: '   ' },
    })
    expect(empty.statusCode).toBe(400)
  })

  it('requires tenant.manage permission', async () => {
    const analyst = await seedActiveMember(app, ownerA.tenantId!, 'analyst')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(analyst),
      payload: { name: 'Nope' },
    })
    expect(res.statusCode).toBe(403)
  })
})
