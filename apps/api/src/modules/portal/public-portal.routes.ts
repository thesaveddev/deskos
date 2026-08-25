import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { createMagicLinkToken } from '../auth/magic-link.js'
import '../../types.js'

/**
 * Public tenant admin routes. No authentication: an organization shares
 * its portal URL (reydesk.com/portal/<slug>) with staff and customers, who can
 * read public knowledge-base articles before signing in. Everything here is
 * gated by the organization's own portal settings.
 */

interface PublicPortalMeta {
  name: string
  slug: string
  branding: { portalTitle?: string | null; logoUrl?: string | null; primaryColor?: string | null }
  portalEnabled: boolean
  allowPublicKb: boolean
  welcomeMessage: string
  allowRegistration: boolean
}

async function resolveTenant(app: FastifyInstance, slug: string): Promise<{ tenantId: string; meta: PublicPortalMeta } | null> {
  const { rows } = await app.db.query(
    `SELECT id, name, settings FROM tenants
      WHERE lower(slug) = lower($1)
         OR lower(settings->'portal'->>'slug') = lower($1)`,
    [slug.trim()],
  )
  const tenant = rows[0]
  if (!tenant) return null
  const settings = (tenant.settings ?? {}) as Record<string, unknown>
  const portal = (settings.portal ?? {}) as Record<string, unknown>
  const branding = (settings.branding ?? {}) as Record<string, unknown>
  return {
    tenantId: tenant.id,
    meta: {
      name: tenant.name,
      slug: slug.trim(),
      branding: {
        portalTitle: typeof branding.portalTitle === 'string' ? branding.portalTitle : null,
        logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
        primaryColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : null,
      },
      portalEnabled: portal.enabled !== false,
      allowPublicKb: portal.allow_public_kb !== false,
      welcomeMessage: typeof portal.welcome_message === 'string' ? portal.welcome_message : '',
      allowRegistration: portal.allow_registration === true,
    },
  }
}

function pagination(query: Record<string, unknown>): { page: number; pageSize: number; offset: number } {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 12))
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export async function publicPortalRoutes(app: FastifyInstance): Promise<void> {
  // Public portal metadata — lets the portal page render org branding before
  // any sign-in and 404s when the org has disabled its portal.
  app.get('/public/portal/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    return reply.send(resolved.meta)
  })

  // Public KB folder/category listing.
  app.get('/public/portal/:slug/kb/categories', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    if (!resolved.meta.allowPublicKb) throw AppError.notFound('Knowledge base is not public')

    return withTenant(app.db, resolved.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT f.id, f.name, f.parent_id, f.created_at,
                count(a.id)::int AS article_count
           FROM kb_folders f
           LEFT JOIN kb_articles a ON a.folder_id = f.id AND a.status = 'published' AND a.visibility = 'public'
          GROUP BY f.id, f.name, f.parent_id, f.created_at
          HAVING count(a.id) > 0
          ORDER BY lower(f.name)`,
      )
      return reply.send({ categories: rows })
    })
  })

  // Public list KB listing — tenant-scoped via RLS, only `public` + `published`
  // articles, and only when the org allows a public KB.
  app.get('/public/portal/:slug/kb', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    if (!resolved.meta.allowPublicKb) throw AppError.notFound('Knowledge base is not public')

    const query = request.query as Record<string, unknown>
    const { page, pageSize, offset } = pagination(query)
    return withTenant(app.db, resolved.tenantId, async (client) => {
      const clauses = [`a.status = 'published'`, `a.visibility = 'public'`]
      const values: unknown[] = []
      if (query.q) {
        values.push(String(query.q).trim())
        clauses.push(`to_tsvector('simple', coalesce(a.title, '') || ' ' || coalesce(a.summary, '') || ' ' || coalesce(a.body, '')) @@ plainto_tsquery('simple', $${values.length})`)
      }
      if (query.folderId) {
        values.push(query.folderId)
        clauses.push(`a.folder_id = $${values.length}`)
      }
      const where = `WHERE ${clauses.join(' AND ')}`
      const total = Number((await client.query(`SELECT count(*)::int AS total FROM kb_articles a ${where}`, values)).rows[0].total)
      values.push(pageSize, offset)
      const { rows } = await client.query(
        `SELECT a.id, a.title, a.summary, a.folder_id, a.visibility, a.tags, a.updated_at
           FROM kb_articles a ${where}
          ORDER BY a.updated_at DESC
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      )
      return reply.send({ articles: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } })
    })
  })

  // Public article detail + relations (public articles only).
  app.get('/public/portal/:slug/kb/:id', async (request, reply) => {
    const { slug, id } = request.params as { slug: string; id: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    if (!resolved.meta.allowPublicKb) throw AppError.notFound('Article not found')

    return withTenant(app.db, resolved.tenantId, async (client) => {
      await client.query(
        `UPDATE kb_articles SET view_count = view_count + 1
          WHERE id = $1 AND status = 'published' AND visibility = 'public'`,
        [id],
      )
      const article = (
        await client.query(
          `SELECT id, title, summary, body, folder_id, visibility, tags, version,
                  helpful_count, not_helpful_count, updated_at
             FROM kb_articles
            WHERE id = $1 AND status = 'published' AND visibility = 'public'`,
          [id],
        )
      ).rows[0]
      if (!article) throw AppError.notFound('Article not found')
      const relations = await client.query(
        `SELECT r.relation_type, a.id AS related_article_id, a.title AS related_title, a.summary AS related_summary
           FROM kb_article_relations r JOIN kb_articles a ON a.id = r.related_article_id
          WHERE r.article_id = $1 AND a.status = 'published' AND a.visibility = 'public'
          ORDER BY a.title`,
        [id],
      )
      return reply.send({ article, relations: relations.rows })
    })
  })

  // Registration metadata — lets the portal page decide whether to show a
  // "Create an account" option and render the org's welcome message.
  app.get('/public/portal/:slug/register/meta', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    return reply.send({
      allowRegistration: resolved.meta.allowRegistration,
      welcomeMessage: resolved.meta.welcomeMessage,
      portalName: resolved.meta.name,
    })
  })

  const registerSchema = z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().email().max(320),
  })

  // Self-service portal registration. Creates a disabled-by-default end-user
  // account and sends a magic-link welcome email. Only allowed when the org
  // has enabled portal registration, and only for allowed email domains.
  app.post('/public/portal/:slug/register', {
    config: { rateLimit: { max: 8, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const resolved = await resolveTenant(app, slug)
    if (!resolved || !resolved.meta.portalEnabled) throw AppError.notFound('Portal not found')
    if (!resolved.meta.allowRegistration) throw AppError.forbidden('Portal registration is not enabled for this organization', 'registration_disabled')

    const body = registerSchema.parse(request.body)
    const email = body.email.trim().toLowerCase()

    // Only allow emails from the configured domains when an allowlist exists.
    const portalSettings = (await app.db.query(
      `SELECT settings->'portal' AS portal FROM tenants WHERE id = $1`,
      [resolved.tenantId],
    )).rows[0]?.portal as Record<string, unknown> | undefined
    const domains = Array.isArray(portalSettings?.registration_domains)
      ? (portalSettings.registration_domains as string[]).map((d) => d.toLowerCase()).filter(Boolean)
      : []
    if (domains.length > 0) {
      const domain = email.split('@').pop()?.toLowerCase() ?? ''
      if (!domains.includes(domain)) {
        throw AppError.forbidden('This email domain is not allowed to register for this portal. Contact your IT team for an invite.', 'domain_not_allowed')
      }
    }

    const existing = await app.db.query(
      `SELECT u.id, m.tenant_id FROM users u
        LEFT JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2
       WHERE lower(u.email) = $1`,
      [email, resolved.tenantId],
    )
    const existingUser = existing.rows[0]
    if (existingUser?.tenant_id) {
      throw AppError.conflict('An account with this email already has access to this portal. Try signing in instead.', 'email_already_registered')
    }

    const existingId = existingUser?.id as string | undefined
    let userId: string
    if (existingId) {
      // A global account already exists (member of another org) — reuse it.
      userId = existingId
      await app.db.query(`UPDATE users SET name = $2 WHERE id = $1`, [userId, body.name])
    } else {
      const created = await app.db.query(
        `INSERT INTO users (email, name, status) VALUES ($1, $2, 'active') RETURNING id`,
        [email, body.name],
      )
      userId = created.rows[0].id as string
    }

    await app.db.query(
      `INSERT INTO memberships (tenant_id, user_id, org_role, status) VALUES ($1, $2, 'end_user', 'active')
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active'`,
      [resolved.tenantId, userId],
    )

    const { token } = await createMagicLinkToken(app.db, {
      userId,
      tenantId: resolved.tenantId,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
    const baseUrl = app.config.publicUrl.replace(/\/$/, '')
    const signInUrl = `${baseUrl}/login?magic_token=${encodeURIComponent(token)}`
    const jobId = await app.emailQueue.addAndSend(app.mailer.buildMagicLinkMail(email, signInUrl, resolved.meta.name))
    app.log.info({ userId, tenantId: resolved.tenantId, jobId, mailConfigured: app.mailer.enabled }, 'Portal registration magic link queued')

    return reply.code(201).send({
      ok: true,
      message: 'Your account was created. Check your email for a sign-in link to continue.',
    })
  })
}