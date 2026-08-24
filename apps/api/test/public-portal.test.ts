import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('public customer portal', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Public Portal Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    foreignOwner = await signupOwner(app, { tenantName: 'Hidden Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('serves portal metadata publicly for the organisation slug', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('Public Portal Org')
    expect(body.slug).toBe(owner.tenantSlug)
    expect(body.portalEnabled).toBe(true)
    expect(body.allowPublicKb).toBe(true)
    expect(body.branding).toBeDefined()
  })

  it('404s for an unknown slug', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/portal/no-such-org' })
    expect(res.statusCode).toBe(404)
  })

  it('404s when the organisation disables its portal', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(owner),
      payload: { portal: { enabled: false } },
    })
    expect(patch.statusCode).toBe(200)
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}` })
    expect(res.statusCode).toBe(404)
    // Re-enable for the remaining tests.
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(owner),
      payload: { portal: { enabled: true } },
    })
  })

  it('exposes only published public articles through the public KB', async () => {
    const draft = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/articles',
      headers: authHeaders(manager),
      payload: { title: 'Public how-to', summary: 'Open to everyone', body: 'Steps here', visibility: 'public' },
    })
    expect(draft.statusCode).toBe(201)
    const article = draft.json().article

    // Draft is not visible yet.
    let list = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb` })
    expect(list.statusCode).toBe(200)
    expect(list.json().articles).toHaveLength(0)

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/kb/articles/${article.id}/status`,
      headers: authHeaders(manager),
      payload: { status: 'published' },
    })
    expect(publish.statusCode).toBe(200)

    list = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb` })
    expect(list.statusCode).toBe(200)
    const articles = list.json().articles
    expect(articles).toHaveLength(1)
    expect(articles[0].id).toBe(article.id)
    expect(articles[0].body).toBeUndefined()

    const detail = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb/${article.id}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().article.title).toBe('Public how-to')
  })

  it('never exposes portal-only or internal articles publicly', async () => {
    const portalOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/articles',
      headers: authHeaders(manager),
      payload: { title: 'Portal secret', body: 'x', visibility: 'portal', status: 'published' },
    })
    expect(portalOnly.statusCode).toBe(201)
    const list = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb` })
    const ids = list.json().articles.map((a: { id: string }) => a.id)
    expect(ids).not.toContain(portalOnly.json().article.id)

    const direct = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb/${portalOnly.json().article.id}` })
    expect(direct.statusCode).toBe(404)
  })

  it('hides the public KB when the organisation disables it', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(owner),
      payload: { portal: { allow_public_kb: false } },
    })
    const list = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${owner.tenantSlug}/kb` })
    expect(list.statusCode).toBe(404)
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(owner),
      payload: { portal: { allow_public_kb: true } },
    })
  })

  it('reports the configured portal URL in tenant settings', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tenant/settings', headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.portal.slug).toBe(owner.tenantSlug)
    expect(body.portal.url).toContain(`/portal/${owner.tenantSlug}`)
  })

  it('honours a custom portal slug in the public URL', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(owner),
      payload: { portal: { slug: 'it-help' } },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().portal.url).toContain('/portal/it-help')
    const res = await app.inject({ method: 'GET', url: '/api/v1/public/portal/it-help' })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Public Portal Org')
  })

  it('a foreign organisation portal is unaffected', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/public/portal/${foreignOwner.tenantSlug}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Hidden Org')
  })
})