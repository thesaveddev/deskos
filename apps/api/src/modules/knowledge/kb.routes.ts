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

const folderSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().uuid().optional(),
  visibility: z.enum(VISIBILITIES).default('internal'),
})

const articleCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  body: z.string().max(200_000).default(''),
  folderId: z.string().uuid().optional(),
  visibility: z.enum(VISIBILITIES).default('internal'),
  status: z.enum(STATUSES).default('draft'),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reviewDueAt: z.string().datetime().optional(),
})

const articleUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  body: z.string().max(200_000).optional(),
  folderId: z.string().uuid().nullable().optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  reviewDueAt: z.string().datetime().nullable().optional(),
})

const statusSchema = z.object({ status: z.enum(STATUSES) })
const feedbackSchema = z.object({
  helpful: z.boolean().optional(),
  comment: z.string().trim().max(2000).optional(),
})

async function recordVersion(client: DbClient, tenantId: string, articleId: string, version: number, title: string, body: string, authorId: string): Promise<void> {
  await client.query(
    `INSERT INTO kb_article_versions (tenant_id, article_id, version, title, body, author_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, articleId, version, title, body, authorId],
  )
}

/** Find a published article visible to portal readers (portal|public). */
async function findPublished(client: DbClient, articleId: string): Promise<{ id: string; title: string; body: string; visibility: string; tags: string[]; version: number; created_at: Date; updated_at: Date } | undefined> {
  const { rows } = await client.query(
    `SELECT id, title, body, visibility, tags, version, created_at, updated_at
       FROM kb_articles
      WHERE id = $1 AND status = 'published' AND visibility IN ('portal', 'public')`,
    [articleId],
  )
  return rows[0]
}

export async function kbRoutes(app: FastifyInstance): Promise<void> {
  // ---- Folders (internal) -------------------------------------------------
  app.get('/kb/folders', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(`SELECT id, name, parent_id, visibility, created_at FROM kb_folders ORDER BY name ASC`)
        .then((r) => ({ folders: r.rows })),
    )
  })

  app.post('/kb/folders', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = folderSchema.parse(request.body)
    const folder = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO kb_folders (tenant_id, name, parent_id, visibility)
         VALUES ($1, $2, $3, $4) RETURNING id, name, parent_id, visibility, created_at`,
        [ctx.tenantId, body.name, body.parentId ?? null, body.visibility],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'kb.folder.created',
        objectType: 'kb_folder',
        objectId: res.rows[0].id,
        ip: request.ip,
      })
      return res.rows[0]
    })
    return reply.code(201).send({ folder })
  })

  // ---- Articles (internal) ------------------------------------------------
  app.get('/kb/articles', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { q?: string; status?: string; folderId?: string; tag?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const clauses: string[] = []
      const values: unknown[] = []
      if (query.status && (STATUSES as readonly string[]).includes(query.status)) {
        values.push(query.status)
        clauses.push(`status = $${values.length}`)
      }
      if (query.folderId) {
        values.push(query.folderId)
        clauses.push(`folder_id = $${values.length}`)
      }
      if (query.tag) {
        values.push(query.tag)
        clauses.push(`$${values.length} = ANY(tags)`)
      }
      if (query.q) {
        values.push(`%${query.q}%`)
        clauses.push(`(title ILIKE $${values.length} OR body ILIKE $${values.length})`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const res = await client.query(
        `SELECT a.id, a.title, a.body, a.folder_id, a.visibility, a.status, a.version, a.tags, a.review_due_at, a.created_at, a.updated_at,
                u.name AS author_name
           FROM kb_articles a
           LEFT JOIN users u ON u.id = a.author_id
           ${where}
          ORDER BY a.updated_at DESC
          LIMIT 100`,
        values,
      )
      return { articles: res.rows }
    })
  })

  app.post('/kb/articles', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = articleCreateSchema.parse(request.body)
    const article = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO kb_articles
           (tenant_id, folder_id, title, body, visibility, status, author_id, version, tags, review_due_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9)
         RETURNING id, title, body, folder_id, visibility, status, version, tags, created_at, updated_at`,
        [ctx.tenantId, body.folderId ?? null, body.title, body.body, body.visibility, body.status, request.user!.id, body.tags ?? [], body.reviewDueAt ?? null],
      )
      const row = res.rows[0]
      await recordVersion(client, ctx.tenantId, row.id, 1, body.title, body.body, request.user!.id)
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'kb.article.created',
        objectType: 'kb_article',
        objectId: row.id,
        ip: request.ip,
      })
      return row
    })
    return reply.code(201).send({ article })
  })

  app.get('/kb/articles/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.*, u.name AS author_name FROM kb_articles a LEFT JOIN users u ON u.id = a.author_id WHERE a.id = $1`,
        [id],
      )
      if (!rows[0]) throw AppError.notFound('Article not found')
      const versions = await client.query(
        `SELECT version, title, author_id, created_at FROM kb_article_versions WHERE article_id = $1 ORDER BY version DESC`,
        [id],
      )
      return { article: rows[0], versions: versions.rows }
    })
  })

  app.patch('/kb/articles/:id', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = articleUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM kb_articles WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Article not found')

      const nextTitle = body.title ?? current.title
      const nextBody = body.body ?? current.body
      const contentChanged = body.title !== undefined || body.body !== undefined
      const version = contentChanged ? current.version + 1 : current.version

      const res = await client.query(
        `UPDATE kb_articles SET
           title = $2, body = $3, folder_id = $4, visibility = $5, tags = $6, review_due_at = $7, version = $8, updated_at = now()
         WHERE id = $1
         RETURNING id, title, body, folder_id, visibility, status, version, tags, review_due_at, updated_at`,
        [id, nextTitle, nextBody, body.folderId === undefined ? current.folder_id : body.folderId, body.visibility ?? current.visibility, body.tags ?? current.tags, body.reviewDueAt === undefined ? current.review_due_at : body.reviewDueAt, version],
      )
      if (contentChanged) {
        await recordVersion(client, ctx.tenantId, id, version, nextTitle, nextBody, request.user!.id)
      }
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'kb.article.updated',
        objectType: 'kb_article',
        objectId: id,
        ip: request.ip,
        payload: { version },
      })
      return { article: res.rows[0] }
    })
  })

  app.post('/kb/articles/:id/status', { preHandler: [authenticate, requireTenant, requirePermission('kb.write')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const { status } = statusSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE kb_articles SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, status, updated_at`,
        [id, status],
      )
      if (!res.rows[0]) throw AppError.notFound('Article not found')
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: `kb.article.${status}`,
        objectType: 'kb_article',
        objectId: id,
        ip: request.ip,
      })
      return { article: res.rows[0] }
    })
  })

  app.get('/kb/articles/:id/versions', { preHandler: [authenticate, requireTenant, requirePermission('kb.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `SELECT version, title, author_id, created_at FROM kb_article_versions WHERE article_id = $1 ORDER BY version DESC`,
        [id],
      )
      return { versions: res.rows }
    })
  })

  // ---- Portal (any tenant member; published, portal/public only) -----------
  app.get('/portal/kb/articles', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    const { q } = request.query as { q?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const values: unknown[] = []
      const clauses = [`status = 'published'`, `visibility IN ('portal', 'public')`]
      if (q) {
        values.push(`%${q}%`)
        clauses.push(`(title ILIKE $${values.length} OR body ILIKE $${values.length})`)
      }
      const res = await client.query(
        `SELECT id, title, body, visibility, tags, version, updated_at
           FROM kb_articles
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT 100`,
        values,
      )
      return { articles: res.rows }
    })
  })

  app.get('/portal/kb/articles/:id', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const article = await findPublished(client, id)
      if (!article) throw AppError.notFound('Article not found')
      const feedback = await client.query(
        `SELECT helpful, comment, created_at FROM kb_feedback WHERE article_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [id],
      )
      return { article, feedback: feedback.rows }
    })
  })

  app.post('/portal/kb/articles/:id/feedback', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = feedbackSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const article = await findPublished(client, id)
      if (!article) throw AppError.notFound('Article not found')
      const res = await client.query(
        `INSERT INTO kb_feedback (tenant_id, article_id, user_id, helpful, comment)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, helpful, comment, created_at`,
        [ctx.tenantId, id, request.user!.id, body.helpful ?? null, body.comment ?? ''],
      )
      return reply.code(201).send({ feedback: res.rows[0] })
    })
  })
}
