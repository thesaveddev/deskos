import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticate } from '../../middleware/authenticate.js'
import '../../types.js'

const tenantPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens')
    .optional(),
  region: z.string().trim().min(1).max(60).optional(),
})

export async function tenantRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/tenant',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query(
        'SELECT id, name, slug, region, settings, created_at FROM tenants WHERE id = $1',
        [ctx.tenantId],
      )
      const tenant = rows[0]
      return {
        tenant,
        membership: { orgRole: ctx.orgRole, membershipId: ctx.membershipId },
      }
    },
  )

  app.patch(
    '/tenant',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.manage')] },
    async (request, reply) => {
      const body = tenantPatchSchema.parse(request.body)
      const ctx = request.tenantCtx!

      if (body.slug) {
        const { rows } = await app.db.query('SELECT id FROM tenants WHERE slug = $1', [body.slug])
        if (rows.length > 0 && rows[0].id !== ctx.tenantId) {
          throw new AppError(409, 'slug_taken', 'That slug is already in use.')
        }
      }

      const sets: string[] = []
      const values: unknown[] = []
      let i = 1
      for (const key of ['name', 'slug', 'region'] as const) {
        if (body[key] !== undefined) {
          sets.push(`${key} = $${i++}`)
          values.push(body[key])
        }
      }
      if (sets.length === 0) return { ok: true }

      values.push(ctx.tenantId)
      const { rows } = await app.db.query(
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, name, slug, region, settings, created_at`,
        values,
      )
      reply.code(200)
      return { ok: true, tenant: rows[0] }
    },
  )

  // ── MFA Policy ──

  app.get(
    '/tenant/mfa-policy',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const settings = rows[0]?.settings ?? {}
      return {
        mfa_policy: settings.mfa_policy ?? 'optional',
        // Count users with/without MFA
        users_with_mfa: 0,
        users_total: 0,
      }
    },
  )

  app.patch(
    '/tenant/mfa-policy',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.manage')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const body = (request.body || {}) as { mfa_policy?: string }
      const policy = body.mfa_policy
      if (!policy || !['optional', 'required', 'admin_only'].includes(policy)) {
        throw new AppError(400, 'invalid_policy', 'mfa_policy must be optional, required, or admin_only')
      }

      // Merge into existing settings
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const settings = { ...(rows[0]?.settings ?? {}), mfa_policy: policy }
      await app.db.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [ctx.tenantId, JSON.stringify(settings)])

      // Count affected users
      const { rows: stats } = await app.db.query(
        `SELECT
           count(*) FILTER (WHERE u.mfa_enabled = true) AS with_mfa,
           count(*) AS total
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'`,
        [ctx.tenantId],
      )

      reply.code(200)
      return {
        ok: true,
        mfa_policy: policy,
        users_with_mfa: Number(stats[0]?.with_mfa ?? 0),
        users_total: Number(stats[0]?.total ?? 0),
        users_needing_setup: policy === 'required'
          ? Number(stats[0]?.total ?? 0) - Number(stats[0]?.with_mfa ?? 0)
          : 0,
      }
    },
  )

  // ── Tenant settings (ticket behaviour, etc.) ──

  const DEFAULT_SETTINGS = {
    ticket_prefix: 'TKT',
    auto_assign_enabled: false,
    auto_close_enabled: false,
    auto_close_after_days: 7,
    require_description: true,
    allow_attachments: true,
    public_notes_visible: true,
    default_priority: 'p3',
    default_type: 'incident',
  }

  app.get(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const raw = rows[0]?.settings ?? {}
      return { settings: { ...DEFAULT_SETTINGS, ...raw } }
    },
  )

  app.patch(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.write')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const body = (request.body || {}) as Record<string, unknown>
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const current = rows[0]?.settings ?? {}
      const merged = { ...current, ...body }
      await app.db.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [ctx.tenantId, JSON.stringify(merged)])
      reply.code(200)
      return { settings: { ...DEFAULT_SETTINGS, ...merged } }
    },
  )
}
