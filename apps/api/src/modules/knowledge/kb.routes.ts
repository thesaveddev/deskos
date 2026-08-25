import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const VISIBILITIES = ['internal', 'portal', 'public'] as const
const STATUSES = ['draft', 'review', 'published', 'archived'] as const
const RELATION_TYPES = ['related', 'prerequisite', 'follow_up'] as const

const folderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().nullable().optional(),
  visibility: z.enum(VISIBILITIES).default('internal'),
})

const folderUpdateSchema = folderSchema.partial()

const articleCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(600).default(''),
  body: z.string().max(200_000).default(''),
  folderId: z.string().uuid().nullable().optional(),
  visibility: z.enum(VISIBILITIES).default('internal'),
  status: z.enum(STATUSES).default('draft'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
})

const articleUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().max(600).optional(),
  body: z.string().max(200_000).optional(),
  folderId: z.string().uuid().nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
})

const statusSchema = z.object({ status: z.enum(STATUSES) })
const relationSchema = z.object({
  relatedArticleId: z.string().uuid(),
  relationType: z.enum(RELATION_TYPES).default('related'),
})
const feedbackSchema = z.object({
  helpful: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
})

function pagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Math.min(10_000, Number(query.page) || 1))
  const pageSize = Math.max(5, Math.min(100, Number(query.pageSize) || 25))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

function articleOrder(sort: unknown): string {
  switch (sort) {
    case 'views': return 'a.view_count DESC, a.updated_at DESC'
    case 'helpful': return 'a.helpful_count DESC, a.updated_at DESC'
    case 'review_due': return 'a.review_due_at ASC NULLS LAST, a.updated_at DESC'
    case 'title': return 'a.title ASC'
    default: return 'a.updated_at DESC'
  }
}

async function ensureFolder(client: DbClient, tenantId: string, folderId: string | null | undefined): Promise<void> {
  if (folderId === undefined || folderId === null) return
  const result = await client.query('SELECT 1 FROM kb_folders WHERE id = $1 AND tenant_id = $2', [folderId, tenantId])
  if (!result.rows[0]) throw AppError.badRequest('Folder does not belong to this organization', 'invalid_folder')
}

async function ensureArticle(client: DbClient, articleId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM kb_articles WHERE id = $1', [articleId])
  if (!result.rows[0]) throw AppError.notFound('Article not found')
}

async function recordVersion(client: DbClient, tenantId: string, articleId: string, version: number, title: string, summary: string, body: string, authorId: string): Promise<void> {
  await client.query(
    `INSERT INTO kb_article_versions (tenant_id, article_id, version, title, summary, body, author_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, articleId, version, title, summary, body, authorId],
  )
}

/** Find a published article visible to portal readers (portal|public). */
async function findPublished(client: DbClient, articleId: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await client.query(
    `SELECT id, title, summary, body, folder_id, visibility, tags, version, view_count, helpful_count, not_helpful_count,
            review_due_at, created_at, updated_at
       FROM kb_articles
      WHERE id = $1 AND status = 'published' AND visibility IN ('portal', 'public')`,
    [articleId],
  )
  return rows[0]
}

export async function kbRoutes(app: FastifyInstance): Promise<void> {
  // ---- Folders -------------------------------------------------------------
  app.get('/kb/folders', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, (client) =>
      client.query(
        `SELECT f.id, f.name, f.parent_id, f.visibility, f.created_at, f.updated_at,
                count(a.id)::int AS article_count
           FROM kb_folders f
           LEFT JOIN kb_articles a ON a.folder_id = f.id
          GROUP BY f.id
          ORDER BY f.name ASC`,
      ).then((r) => ({ folders: r.rows })),
    )
  })

  app.post('/kb/folders', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = folderSchema.parse(request.body)
    const folder = await withTenant(app.db, ctx.tenantId, async (client) => {
      await ensureFolder(client, ctx.tenantId, body.parentId)
      const res = await client.query(
        `INSERT INTO kb_folders (tenant_id, name, parent_id, visibility)
         VALUES ($1, $2, $3, $4) RETURNING id, name, parent_id, visibility, created_at, updated_at`,
        [ctx.tenantId, body.name, body.parentId ?? null, body.visibility],
      )
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.folder.created', objectType: 'kb_folder', objectId: res.rows[0].id, ip: request.ip })
      return res.rows[0]
    })
    return reply.code(201).send({ folder })
  })

  app.patch('/kb/folders/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = folderUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM kb_folders WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Folder not found')
      if (body.parentId === id) throw AppError.badRequest('A folder cannot contain itself', 'invalid_parent')
      await ensureFolder(client, ctx.tenantId, body.parentId)
      if (body.parentId) {
        const cycle = await client.query(
          `WITH RECURSIVE descendants AS (
             SELECT id FROM kb_folders WHERE id = $1 AND tenant_id = $2
             UNION ALL
             SELECT child.id FROM kb_folders child
             JOIN descendants parent ON child.parent_id = parent.id
            )
           SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
          [id, ctx.tenantId, body.parentId],
        )
        if (cycle.rows[0]) throw AppError.badRequest('A folder cannot be moved inside one of its descendants', 'invalid_parent')
      }
      const row = (await client.query(
        `UPDATE kb_folders SET name = $2, parent_id = $3, visibility = $4, updated_at = now()
          WHERE id = $1
          RETURNING id, name, parent_id, visibility, created_at, updated_at`,
        [id, body.name ?? current.name, body.parentId === undefined ? current.parent_id : body.parentId, body.visibility ?? current.visibility],
      )).rows[0]
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.folder.updated', objectType: 'kb_folder', objectId: id, ip: request.ip })
      return { folder: row }
    })
  })

  app.delete('/kb/folders/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await withTenant(app.db, ctx.tenantId, async (client) => {
      const deleted = await client.query('DELETE FROM kb_folders WHERE id = $1 RETURNING id', [id])
      if (!deleted.rows[0]) throw AppError.notFound('Folder not found')
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.folder.deleted', objectType: 'kb_folder', objectId: id, ip: request.ip })
    })
    return reply.code(204).send()
  })

  // ---- Internal analytics --------------------------------------------------
  app.get('/kb/overview', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const summary = (await client.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'draft')::int AS drafts,
                count(*) FILTER (WHERE status = 'review')::int AS review,
                count(*) FILTER (WHERE status = 'published')::int AS published,
                count(*) FILTER (WHERE status = 'archived')::int AS archived,
                count(*) FILTER (WHERE status = 'published' AND review_due_at IS NOT NULL AND review_due_at <= now())::int AS overdue,
                COALESCE(sum(view_count), 0)::int AS views,
                COALESCE(sum(helpful_count), 0)::int AS helpful,
                COALESCE(sum(not_helpful_count), 0)::int AS not_helpful
           FROM kb_articles`,
      )).rows[0]
      const top = (await client.query(
        `SELECT id, title, status, visibility, view_count, helpful_count, not_helpful_count, updated_at
           FROM kb_articles ORDER BY view_count DESC, helpful_count DESC, updated_at DESC LIMIT 8`,
      )).rows
      const due = (await client.query(
        `SELECT id, title, review_due_at, visibility FROM kb_articles
          WHERE status = 'published' AND review_due_at IS NOT NULL AND review_due_at <= now()
          ORDER BY review_due_at ASC LIMIT 8`,
      )).rows
      return { summary, topArticles: top, overdueArticles: due }
    })
  })

  // ---- Articles (internal) -------------------------------------------------
  app.get('/kb/articles', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as Record<string, unknown>
    const { page, pageSize, offset } = pagination(query)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      let searchValueIndex: number | null = null
      if (query.status && (STATUSES as readonly string[]).includes(String(query.status))) { values.push(query.status); clauses.push(`a.status = $${values.length}`) }
      if (query.folderId) { values.push(query.folderId); clauses.push(`a.folder_id = $${values.length}`) }
      if (query.tag) { values.push(query.tag); clauses.push(`$${values.length} = ANY(a.tags)`) }
      if (query.visibility && (VISIBILITIES as readonly string[]).includes(String(query.visibility))) { values.push(query.visibility); clauses.push(`a.visibility = $${values.length}`) }
      if (query.q) {
        values.push(String(query.q).trim())
        searchValueIndex = values.length
        clauses.push(`to_tsvector('simple', coalesce(a.title, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.body, '')) @@ plainto_tsquery('simple', $${values.length})`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const count = (await client.query(`SELECT count(*)::int AS total FROM kb_articles a ${where}`, values)).rows[0].total
      values.push(pageSize); values.push(offset)
      const qRank = searchValueIndex ? `, ts_rank(to_tsvector('simple', coalesce(a.title, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.body, '')), plainto_tsquery('simple', $${searchValueIndex})) AS search_rank` : ''
      const order = query.q ? 'search_rank DESC, a.updated_at DESC' : articleOrder(query.sort)
      const res = await client.query(
        `SELECT a.id, a.title, a.summary, a.body, a.folder_id, a.visibility, a.status, a.version, a.tags, a.review_due_at,
                a.view_count, a.helpful_count, a.not_helpful_count, a.published_at, a.last_reviewed_at, a.created_at, a.updated_at,
                u.name AS author_name${qRank}
           FROM kb_articles a LEFT JOIN users u ON u.id = a.author_id
           ${where} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
      return { articles: res.rows, pagination: { page, pageSize, total: Number(count), totalPages: Math.ceil(Number(count) / pageSize) } }
    })
  })

  app.post('/kb/articles', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = articleCreateSchema.parse(request.body)
    const article = await withTenant(app.db, ctx.tenantId, async (client) => {
      await ensureFolder(client, ctx.tenantId, body.folderId)
      const res = await client.query(
        `INSERT INTO kb_articles
           (tenant_id, folder_id, title, summary, body, visibility, status, author_id, version, tags, review_due_at, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9, $10, CASE WHEN $7 = 'published' THEN now() ELSE NULL END)
         RETURNING id, title, summary, body, folder_id, visibility, status, version, tags, review_due_at, view_count, helpful_count, not_helpful_count, published_at, last_reviewed_at, created_at, updated_at`,
        [ctx.tenantId, body.folderId ?? null, body.title, body.summary, body.body, body.visibility, body.status, request.user!.id, body.tags ?? [], body.reviewDueAt ?? null],
      )
      const row = res.rows[0]
      await recordVersion(client, ctx.tenantId, row.id, 1, body.title, body.summary, body.body, request.user!.id)
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.article.created', objectType: 'kb_article', objectId: row.id, ip: request.ip })
      return row
    })
    return reply.code(201).send({ article })
  })

  app.get('/kb/articles/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(`SELECT a.*, u.name AS author_name FROM kb_articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = $1`, [id])
      if (!rows[0]) throw AppError.notFound('Article not found')
      const versions = await client.query(`SELECT version, title, summary, author_id, created_at FROM kb_article_versions WHERE article_id = $1 ORDER BY version DESC`, [id])
      const relations = await client.query(
        `SELECT r.id, r.relation_type, r.created_at, a.id AS related_article_id, a.title AS related_title, a.status AS related_status
           FROM kb_article_relations r JOIN kb_articles a ON a.id = r.related_article_id
          WHERE r.article_id = $1 ORDER BY a.title`,
        [id],
      )
      return { article: rows[0], versions: versions.rows, relations: relations.rows }
    })
  })

  app.get('/kb/articles/:id/versions/:version', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, version } = request.params as { id: string; version: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const row = (await client.query(
        `SELECT v.version, v.title, v.summary, v.body, v.author_id, v.created_at, u.name AS author_name
           FROM kb_article_versions v LEFT JOIN users u ON u.id = v.author_id
          WHERE v.article_id = $1 AND v.version = $2`,
        [id, Number(version)],
      )).rows[0]
      if (!row) throw AppError.notFound('Article version not found')
      return { version: row }
    })
  })

  // Compare any two stored versions of an article — returns both snapshots so
  // the UI can render a side-by-side diff.
  app.get('/kb/articles/:id/versions/compare', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const query = request.query as { from?: string; to?: string }
    const from = Number(query.from)
    const to = Number(query.to)
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      throw AppError.badRequest('Provide valid from and to version numbers', 'invalid_versions')
    }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT version, title, summary, body, author_id, created_at FROM kb_article_versions
          WHERE article_id = $1 AND version IN ($2, $3)`,
        [id, from, to],
      )
      if (rows.length !== 2) throw AppError.badRequest('One or both versions could not be found', 'version_missing')
      const pick = (version: number) => rows.find((row) => row.version === version)
      return { from: pick(from), to: pick(to) }
    })
  })

  // Restore an older version: the stored content becomes the current content,
  // written as a brand-new version so the rollback itself is auditable and
  // the full history is preserved.
  app.post('/kb/articles/:id/versions/:version/restore', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id, version } = request.params as { id: string; version: string }
    const restoreVersion = Number(version)
    if (!Number.isInteger(restoreVersion) || restoreVersion < 1) throw AppError.badRequest('Invalid version number', 'invalid_version')
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const article = (await client.query('SELECT * FROM kb_articles WHERE id = $1', [id])).rows[0]
      if (!article) throw AppError.notFound('Article not found')
      const snapshot = (await client.query(
        'SELECT title, summary, body FROM kb_article_versions WHERE article_id = $1 AND version = $2',
        [id, restoreVersion],
      )).rows[0]
      if (!snapshot) throw AppError.notFound('Article version not found')
      if (restoreVersion === article.version) throw AppError.badRequest('That version is already the current version', 'current_version')

      const nextVersion = article.version + 1
      const res = await client.query(
        `UPDATE kb_articles SET title = $2, summary = $3, body = $4, version = $5, updated_at = now()
          WHERE id = $1
          RETURNING id, title, summary, body, folder_id, visibility, status, version, tags, review_due_at, view_count, helpful_count, not_helpful_count, published_at, last_reviewed_at, updated_at`,
        [id, snapshot.title, snapshot.summary ?? '', snapshot.body, nextVersion],
      )
      await recordVersion(client, ctx.tenantId, id, nextVersion, snapshot.title, snapshot.summary ?? '', snapshot.body, request.user!.id)
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.article.restored', objectType: 'kb_article', objectId: id, ip: request.ip, payload: { restoredFrom: restoreVersion, version: nextVersion } })
      return { article: res.rows[0], restoredFrom: restoreVersion }
    })
  })

  app.patch('/kb/articles/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = articleUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM kb_articles WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Article not found')
      await ensureFolder(client, ctx.tenantId, body.folderId)
      const nextTitle = body.title ?? current.title
      const nextSummary = body.summary ?? current.summary ?? ''
      const nextBody = body.body ?? current.body
      const contentChanged = body.title !== undefined || body.summary !== undefined || body.body !== undefined
      const version = contentChanged ? current.version + 1 : current.version
      const res = await client.query(
        `UPDATE kb_articles SET title = $2, summary = $3, body = $4, folder_id = $5, visibility = $6, tags = $7,
                review_due_at = $8, version = $9, updated_at = now()
          WHERE id = $1
          RETURNING id, title, summary, body, folder_id, visibility, status, version, tags, review_due_at, view_count, helpful_count, not_helpful_count, published_at, last_reviewed_at, updated_at`,
        [id, nextTitle, nextSummary, nextBody, body.folderId === undefined ? current.folder_id : body.folderId, body.visibility ?? current.visibility, body.tags ?? current.tags, body.reviewDueAt === undefined ? current.review_due_at : body.reviewDueAt, version],
      )
      if (contentChanged) await recordVersion(client, ctx.tenantId, id, version, nextTitle, nextSummary, nextBody, request.user!.id)
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.article.updated', objectType: 'kb_article', objectId: id, ip: request.ip, payload: { version } })
      return { article: res.rows[0] }
    })
  })

  app.post('/kb/articles/:id/status', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { status } = statusSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE kb_articles SET status = $2,
                published_at = CASE WHEN $2 = 'published' THEN COALESCE(published_at, now()) ELSE published_at END,
                last_reviewed_at = CASE WHEN $2 = 'published' THEN now() ELSE last_reviewed_at END,
                updated_at = now()
          WHERE id = $1 RETURNING id, status, published_at, last_reviewed_at, updated_at`,
        [id, status],
      )
      if (!res.rows[0]) throw AppError.notFound('Article not found')
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: `kb.article.${status}`, objectType: 'kb_article', objectId: id, ip: request.ip })
      return { article: res.rows[0] }
    })
  })

  app.get('/kb/articles/:id/versions', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await ensureArticle(client, id)
      const res = await client.query(`SELECT version, title, summary, author_id, created_at FROM kb_article_versions WHERE article_id = $1 ORDER BY version DESC`, [id])
      return { versions: res.rows }
    })
  })

  // ---- Related articles ----------------------------------------------------
  app.get('/kb/articles/:id/relations', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await ensureArticle(client, id)
      const rows = await client.query(
        `SELECT r.id, r.relation_type, r.created_at, a.id AS related_article_id, a.title AS related_title, a.summary AS related_summary, a.status AS related_status, a.visibility AS related_visibility
           FROM kb_article_relations r JOIN kb_articles a ON a.id = r.related_article_id WHERE r.article_id = $1 ORDER BY a.title`,
        [id],
      )
      return { relations: rows.rows }
    })
  })

  app.post('/kb/articles/:id/relations', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = relationSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await ensureArticle(client, id)
      await ensureArticle(client, body.relatedArticleId)
      if (id === body.relatedArticleId) throw AppError.badRequest('An article cannot relate to itself', 'invalid_relation')
      const row = (await client.query(
        `INSERT INTO kb_article_relations (tenant_id, article_id, related_article_id, relation_type, created_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (article_id, related_article_id, relation_type) DO UPDATE SET created_at = kb_article_relations.created_at
         RETURNING id, relation_type, created_at, related_article_id`,
        [ctx.tenantId, id, body.relatedArticleId, body.relationType, request.user!.id],
      )).rows[0]
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.article.relation_created', objectType: 'kb_article', objectId: id, ip: request.ip, payload: { relatedArticleId: body.relatedArticleId, relationType: body.relationType } })
      return reply.code(201).send({ relation: row })
    })
  })

  app.delete('/kb/articles/:id/relations/:relationId', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id, relationId } = request.params as { id: string; relationId: string }
    await withTenant(app.db, ctx.tenantId, async (client) => {
      const deleted = await client.query('DELETE FROM kb_article_relations WHERE id = $1 AND article_id = $2 RETURNING id', [relationId, id])
      if (!deleted.rows[0]) throw AppError.notFound('Article relation not found')
      await recordAudit(client, ctx.tenantId, { actorType: 'user', actorId: request.user!.id, action: 'kb.article.relation_deleted', objectType: 'kb_article', objectId: id, ip: request.ip })
    })
    return reply.code(204).send()
  })

  // ---- Portal (published, portal/public only) -----------------------------
  app.get('/portal/kb/articles', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as Record<string, unknown>
    const { page, pageSize, offset } = pagination(query)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses = [`a.status = 'published'`, `a.visibility IN ('portal', 'public')`]
      const values: unknown[] = []
      if (query.q) { values.push(String(query.q).trim()); clauses.push(`to_tsvector('simple', coalesce(a.title, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.body, '')) @@ plainto_tsquery('simple', $${values.length})`) }
      if (query.tag) { values.push(query.tag); clauses.push(`$${values.length} = ANY(a.tags)`) }
      if (query.folderId) { values.push(query.folderId); clauses.push(`a.folder_id = $${values.length}`) }
      const where = `WHERE ${clauses.join(' AND ')}`
      const total = Number((await client.query(`SELECT count(*)::int AS total FROM kb_articles a ${where}`, values)).rows[0].total)
      values.push(pageSize); values.push(offset)
      const rows = await client.query(
        `SELECT a.id, a.title, a.summary, a.body, a.folder_id, a.visibility, a.tags, a.version, a.view_count, a.helpful_count, a.not_helpful_count, a.updated_at
           FROM kb_articles a ${where} ORDER BY a.helpful_count DESC, a.view_count DESC, a.updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
      return { articles: rows.rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } }
    })
  })

  app.get('/portal/kb/articles/:id', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await client.query(`UPDATE kb_articles SET view_count = view_count + 1 WHERE id = $1 AND status = 'published' AND visibility IN ('portal', 'public')`, [id])
      const article = await findPublished(client, id)
      if (!article) throw AppError.notFound('Article not found')
      const feedback = await client.query(`SELECT id, helpful, comment, created_at FROM kb_feedback WHERE article_id = $1 ORDER BY created_at DESC LIMIT 50`, [id])
      const relations = await client.query(
        `SELECT r.relation_type, a.id AS related_article_id, a.title AS related_title, a.summary AS related_summary
           FROM kb_article_relations r JOIN kb_articles a ON a.id = r.related_article_id
          WHERE r.article_id = $1 AND a.status = 'published' AND a.visibility IN ('portal', 'public') ORDER BY a.title`,
        [id],
      )
      return { article, feedback: feedback.rows, relations: relations.rows }
    })
  })

  app.post('/portal/kb/articles/:id/feedback', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = feedbackSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const article = await findPublished(client, id)
      if (!article) throw AppError.notFound('Article not found')
      const previous = (await client.query(`SELECT id, helpful FROM kb_feedback WHERE article_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`, [id, request.user!.id])).rows[0]
      let feedback
      if (previous) {
        feedback = (await client.query(`UPDATE kb_feedback SET helpful = $2, comment = $3, created_at = now() WHERE id = $1 RETURNING id, helpful, comment, created_at`, [previous.id, body.helpful ?? null, body.comment ?? ''])).rows[0]
      } else {
        feedback = (await client.query(`INSERT INTO kb_feedback (tenant_id, article_id, user_id, helpful, comment) VALUES ($1, $2, $3, $4, $5) RETURNING id, helpful, comment, created_at`, [ctx.tenantId, id, request.user!.id, body.helpful ?? null, body.comment ?? ''])).rows[0]
      }
      const counts = (await client.query(
        `SELECT count(*) FILTER (WHERE helpful = true)::int AS helpful,
                count(*) FILTER (WHERE helpful = false)::int AS not_helpful
           FROM kb_feedback WHERE article_id = $1`,
        [id],
      )).rows[0]
      await client.query('UPDATE kb_articles SET helpful_count = $2, not_helpful_count = $3 WHERE id = $1', [id, counts.helpful, counts.not_helpful])
      return reply.code(previous ? 200 : 201).send({ feedback })
    })
  })
}
