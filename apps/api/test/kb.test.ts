import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('knowledge base', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let manager: Awaited<ReturnType<typeof seedActiveMember>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'KB Org' })
    manager = await seedActiveMember(app, owner.tenantId!, 'service_desk_manager')
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreignOwner = await signupOwner(app, { tenantName: 'KB Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  let folderId: string
  let articleId: string

  it('end_user cannot read the knowledge base', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/kb/articles', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('owner creates a folder', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/folders',
      headers: authHeaders(owner),
      payload: { name: 'How-to guides', visibility: 'internal' },
    })
    expect(res.statusCode).toBe(201)
    folderId = res.json().folder.id
    expect(res.json().folder.name).toBe('How-to guides')
  })

  it('analyst (read-only) cannot create articles', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/articles',
      headers: authHeaders(analyst),
      payload: { title: 'Nope', body: 'x' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('manager creates an article as a draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/kb/articles',
      headers: authHeaders(manager),
      payload: {
        title: 'Resetting your VPN password',
        body: 'Open the client, then choose "Forgot password".',
        folderId,
        visibility: 'portal',
        status: 'draft',
        tags: ['vpn', 'password'],
      },
    })
    expect(res.statusCode).toBe(201)
    articleId = res.json().article.id
    expect(res.json().article.version).toBe(1)
    expect(res.json().article.status).toBe('draft')
  })

  it('draft article is not visible in the portal list', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/portal/kb/articles', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(200)
    expect(res.json().articles).toHaveLength(0)
  })

  it('patching the body bumps the version and records history', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/kb/articles/${articleId}`,
      headers: authHeaders(manager),
      payload: { body: 'Open the client, then choose "Forgot password" and follow the prompts.' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().article.version).toBe(2)

    const versions = await app.inject({
      method: 'GET',
      url: `/api/v1/kb/articles/${articleId}/versions`,
      headers: authHeaders(manager),
    })
    expect(versions.statusCode).toBe(200)
    expect(versions.json().versions).toHaveLength(2)
    expect(versions.json().versions[0].version).toBe(2)
  })

  it('published portal article appears in the portal list and search', async () => {
    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/kb/articles/${articleId}/status`,
      headers: authHeaders(manager),
      payload: { status: 'published' },
    })
    expect(publish.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: '/api/v1/portal/kb/articles', headers: authHeaders(endUser) })
    expect(list.statusCode).toBe(200)
    expect(list.json().articles).toHaveLength(1)
    expect(list.json().articles[0].title).toContain('VPN')

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/portal/kb/articles?q=password',
      headers: authHeaders(endUser),
    })
    expect(search.json().articles).toHaveLength(1)
  })

  it('internal-article search is case-insensitive and tag-filterable', async () => {
    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/kb/articles?q=VPN&tag=vpn',
      headers: authHeaders(manager),
    })
    expect(search.statusCode).toBe(200)
    expect(search.json().articles.length).toBeGreaterThanOrEqual(1)
  })

  it('end_user can read a published portal article and leave feedback', async () => {
    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/portal/kb/articles/${articleId}`,
      headers: authHeaders(endUser),
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().article.title).toContain('VPN')

    const feedback = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/kb/articles/${articleId}/feedback`,
      headers: authHeaders(endUser),
      payload: { helpful: true, comment: 'Worked for me' },
    })
    expect(feedback.statusCode).toBe(201)
    expect(feedback.json().feedback.helpful).toBe(true)
  })

  it('articles are tenant-isolated', async () => {
    const steal = await app.inject({
      method: 'GET',
      url: `/api/v1/kb/articles/${articleId}`,
      headers: authHeaders(foreignOwner),
    })
    expect(steal.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/v1/kb/articles', headers: authHeaders(foreignOwner) })
    expect(list.json().articles).toHaveLength(0)
  })
})
