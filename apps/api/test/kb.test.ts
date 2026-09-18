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

  it('supports relevance search, pagination, and KB overview metrics', async () => {
    const search = await app.inject({ method: 'GET', url: '/api/v1/kb/articles?q=password&page=1&pageSize=5&sort=helpful', headers: authHeaders(manager) })
    expect(search.statusCode).toBe(200)
    expect(search.json().pagination).toMatchObject({ page: 1, pageSize: 5, total: 1, totalPages: 1 })
    expect(search.json().articles[0].summary).toBeDefined()

    const overview = await app.inject({ method: 'GET', url: '/api/v1/kb/overview', headers: authHeaders(manager) })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().summary.published).toBe(1)
    expect(overview.json().summary.helpful).toBe(1)
    expect(overview.json().summary.views).toBeGreaterThanOrEqual(1)
  })

  it('supports related articles and prevents self-relations', async () => {
    const second = await app.inject({ method: 'POST', url: '/api/v1/kb/articles', headers: authHeaders(manager), payload: { title: 'VPN troubleshooting checklist', summary: 'A checklist for diagnosing VPN issues.', body: 'Check DNS and restart the client.', visibility: 'portal', tags: ['vpn'] } })
    expect(second.statusCode).toBe(201)
    const secondId = second.json().article.id

    const self = await app.inject({ method: 'POST', url: `/api/v1/kb/articles/${articleId}/relations`, headers: authHeaders(manager), payload: { relatedArticleId: articleId } })
    expect(self.statusCode).toBe(400)

    const relation = await app.inject({ method: 'POST', url: `/api/v1/kb/articles/${articleId}/relations`, headers: authHeaders(manager), payload: { relatedArticleId: secondId, relationType: 'follow_up' } })
    expect(relation.statusCode).toBe(201)
    const detail = await app.inject({ method: 'GET', url: `/api/v1/kb/articles/${articleId}`, headers: authHeaders(manager) })
    expect(detail.json().relations).toHaveLength(1)
    expect(detail.json().relations[0].relation_type).toBe('follow_up')

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/kb/articles/${articleId}/relations/${relation.json().relation.id}`, headers: authHeaders(manager) })
    expect(removed.statusCode).toBe(204)
  })

  it('lets a requester revise feedback instead of inflating the score', async () => {
    const changed = await app.inject({ method: 'POST', url: `/api/v1/portal/kb/articles/${articleId}/feedback`, headers: authHeaders(endUser), payload: { helpful: false, comment: 'Needs more detail' } })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().feedback.helpful).toBe(false)
    const article = await app.inject({ method: 'GET', url: `/api/v1/portal/kb/articles/${articleId}`, headers: authHeaders(endUser) })
    expect(article.json().article.helpful_count).toBe(0)
    expect(article.json().article.not_helpful_count).toBe(1)
  })

  it('deleting a parent folder preserves child folders as top-level folders', async () => {
    const parent = await app.inject({ method: 'POST', url: '/api/v1/kb/folders', headers: authHeaders(owner), payload: { name: 'Parent folder' } })
    expect(parent.statusCode).toBe(201)
    const parentId = parent.json().folder.id
    const child = await app.inject({ method: 'POST', url: '/api/v1/kb/folders', headers: authHeaders(owner), payload: { name: 'Child folder', parentId } })
    expect(child.statusCode).toBe(201)
    const childId = child.json().folder.id

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/kb/folders/${parentId}`, headers: authHeaders(owner) })
    expect(removed.statusCode).toBe(204)
    const folders = await app.inject({ method: 'GET', url: '/api/v1/kb/folders', headers: authHeaders(owner) })
    expect(folders.json().folders.find((folder: { id: string }) => folder.id === childId)?.parent_id).toBeNull()
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

  describe('article lifecycle', () => {
    const withTenant = async <T,>(fn: (client: import('../src/db/pool.js').DbClient) => Promise<T>): Promise<T> => {
      const { withTenant: wt } = await import('../src/db/pool.js')
      return wt(app.db, owner.tenantId!, fn)
    }

    it('deletes a draft but refuses to delete published or archived articles', async () => {
      const draft = await app.inject({
        method: 'POST',
        url: '/api/v1/kb/articles',
        headers: authHeaders(manager),
        payload: { title: 'Junk draft to delete', body: 'never published' },
      })
      expect(draft.statusCode).toBe(201)
      const draftId = draft.json().article.id as string

      const del = await app.inject({ method: 'DELETE', url: `/api/v1/kb/articles/${draftId}`, headers: authHeaders(manager) })
      expect(del.statusCode).toBe(204)
      const gone = await app.inject({ method: 'GET', url: `/api/v1/kb/articles/${draftId}`, headers: authHeaders(manager) })
      expect(gone.statusCode).toBe(404)

      const published = await app.inject({
        method: 'POST',
        url: '/api/v1/kb/articles',
        headers: authHeaders(manager),
        payload: { title: 'Published article cannot be deleted', body: 'live content', status: 'published', visibility: 'portal' },
      })
      const publishedId = published.json().article.id as string

      const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/kb/articles/${publishedId}`, headers: authHeaders(manager) })
      expect(blocked.statusCode).toBe(409)
      expect(blocked.json().error?.code ?? blocked.json().code).toBe('kb_article_not_deletable')

      // Archiving keeps it undeletable — the archive IS the retirement state.
      await app.inject({ method: 'POST', url: `/api/v1/kb/articles/${publishedId}/status`, headers: authHeaders(manager), payload: { status: 'archived' } })
      const stillBlocked = await app.inject({ method: 'DELETE', url: `/api/v1/kb/articles/${publishedId}`, headers: authHeaders(manager) })
      expect(stillBlocked.statusCode).toBe(409)
    })

    it('notifies the author once per overdue review date, and re-arms after the date moves', async () => {
      const overdue = await app.inject({
        method: 'POST',
        url: '/api/v1/kb/articles',
        headers: authHeaders(manager),
        payload: {
          title: 'Stale article needing review',
          body: 'review is overdue',
          status: 'published',
          visibility: 'portal',
          reviewDueAt: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        },
      })
      expect(overdue.statusCode).toBe(201)
      const staleId = overdue.json().article.id as string

      const { checkKbReviewNotices } = await import('../src/modules/knowledge/review.js')
      const first = await checkKbReviewNotices(app.db)
      expect(first.notified).toBeGreaterThanOrEqual(1)

      const notices = async () => (await withTenant((client) => client.query(
        `SELECT count(*)::int AS n FROM notifications WHERE kind = 'kb.review_due' AND subject_id = $1`,
        [staleId],
      ))).rows[0].n as number
      expect(await notices()).toBe(1)

      // Second sweep: the same overdue episode does not re-notify.
      await checkKbReviewNotices(app.db)
      expect(await notices()).toBe(1)

      // Reviewing the article (moving the date forward) starts a new episode:
      // when that date passes, the author is notified again.
      await withTenant((client) => client.query(
        `UPDATE kb_articles SET review_due_at = now() - interval '1 day', last_reviewed_at = now() WHERE id = $1`,
        [staleId],
      ))
      const again = await checkKbReviewNotices(app.db)
      expect(again.notified).toBeGreaterThanOrEqual(1)
      expect(await notices()).toBe(2)
    })
  })
})
