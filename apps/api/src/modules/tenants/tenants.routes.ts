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
      const policy = settings.mfa_policy ?? 'optional'
      const { rows: stats } = await app.db.query(
        `SELECT
           count(*)::int AS users_total,
           count(*) FILTER (WHERE u.mfa_enabled = true)::int AS users_with_mfa,
           count(*) FILTER (
             WHERE u.mfa_enabled = false
               AND ($2 = 'required' OR ($2 = 'admin_only' AND m.org_role IN ('admin', 'owner')))
           )::int AS users_needing_setup
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'`,
        [ctx.tenantId, policy],
      )
      return {
        mfa_policy: policy,
        users_with_mfa: Number(stats[0]?.users_with_mfa ?? 0),
        users_total: Number(stats[0]?.users_total ?? 0),
        users_needing_setup: Number(stats[0]?.users_needing_setup ?? 0),
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
           count(*) FILTER (WHERE u.mfa_enabled = true)::int AS with_mfa,
           count(*)::int AS total,
           count(*) FILTER (
             WHERE u.mfa_enabled = false
               AND ($2 = 'required' OR ($2 = 'admin_only' AND m.org_role IN ('admin', 'owner')))
           )::int AS needing_setup
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.tenant_id = $1 AND m.status = 'active' AND u.status = 'active'`,
        [ctx.tenantId, policy],
      )

      reply.code(200)
      return {
        ok: true,
        mfa_policy: policy,
        users_with_mfa: Number(stats[0]?.with_mfa ?? 0),
        users_total: Number(stats[0]?.total ?? 0),
        users_needing_setup: Number(stats[0]?.needing_setup ?? 0),
      }
    },
  )

  // ── Tenant settings ───────────────────────────────────────────────────────
  // Settings are kept in the existing tenant JSON document so deployments do
  // not need a migration for every new product preference. The route still
  // validates and whitelists keys so arbitrary data cannot be written here.

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
    portal: {
      enabled: true,
      allow_public_kb: true,
      show_device_context: true,
      allow_customer_resolution: true,
    },
    magic_links: {
      portal_enabled: true,
      staff_enabled: false,
    },
    ai_triage: {
      enabled: true,
      autoReply: true,
      autoResolve: true,
      maxRounds: 4,
      resolveConfidence: 0.92,
      sources: ['portal', 'email', 'phone'],
    },
    remote_support: {
      require_consent: true,
      default_expiry_minutes: 30,
      allow_file_transfer: true,
      allow_clipboard: true,
      allow_terminal: false,
      allow_system_manage: false,
      default_recording_mode: 'metadata',
      recording_retention_days: 30,
    },
    endpoints: {
      offline_after_minutes: 10,
      heartbeat_interval_seconds: 30,
      allow_self_enrollment: true,
      enrollment_code_expiry_minutes: 15,
    },
    monitoring: {
      create_tickets_by_default: true,
      offline_ticket_mode: 'alert_only',
      default_ticket_priority: 'p3',
      default_severity: 'warning',
    },
    data_retention: {
      audit_days: 365,
      recording_days: 30,
      notification_days: 90,
    },
  }

  const tenantSettingsPatchSchema = z.object({
    ticket_prefix: z.string().trim().min(1).max(12).optional(),
    auto_assign_enabled: z.boolean().optional(),
    auto_close_enabled: z.boolean().optional(),
    auto_close_after_days: z.number().int().min(1).max(365).optional(),
    require_description: z.boolean().optional(),
    allow_attachments: z.boolean().optional(),
    public_notes_visible: z.boolean().optional(),
    default_priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
    default_type: z.enum(['incident', 'service_request', 'question', 'problem', 'change']).optional(),
    portal: z.object({
      enabled: z.boolean().optional(),
      allow_public_kb: z.boolean().optional(),
      show_device_context: z.boolean().optional(),
      allow_customer_resolution: z.boolean().optional(),
    }).partial().optional(),
    magic_links: z.object({
      portal_enabled: z.boolean().optional(),
      staff_enabled: z.boolean().optional(),
    }).partial().optional(),
    ai_triage: z.object({
      enabled: z.boolean().optional(),
      autoReply: z.boolean().optional(),
      autoResolve: z.boolean().optional(),
      maxRounds: z.number().int().min(1).max(8).optional(),
      resolveConfidence: z.number().min(0.5).max(0.99).optional(),
      sources: z.array(z.enum(['portal', 'email', 'phone'])).min(1).optional(),
    }).partial().optional(),
    remote_support: z.object({
      require_consent: z.boolean().optional(),
      default_expiry_minutes: z.number().int().min(5).max(1440).optional(),
      allow_file_transfer: z.boolean().optional(),
      allow_clipboard: z.boolean().optional(),
      allow_terminal: z.boolean().optional(),
      allow_system_manage: z.boolean().optional(),
      default_recording_mode: z.enum(['off', 'metadata', 'video']).optional(),
      recording_retention_days: z.number().int().min(1).max(3650).optional(),
    }).partial().optional(),
    endpoints: z.object({
      offline_after_minutes: z.number().int().min(1).max(1440).optional(),
      heartbeat_interval_seconds: z.number().int().min(10).max(3600).optional(),
      allow_self_enrollment: z.boolean().optional(),
      enrollment_code_expiry_minutes: z.number().int().min(5).max(1440).optional(),
    }).partial().optional(),
    monitoring: z.object({
      create_tickets_by_default: z.boolean().optional(),
      offline_ticket_mode: z.enum(['alert_only', 'ticket']).optional(),
      default_ticket_priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
      default_severity: z.enum(['info', 'warning', 'critical']).optional(),
    }).partial().optional(),
    data_retention: z.object({
      audit_days: z.number().int().min(30).max(3650).optional(),
      recording_days: z.number().int().min(1).max(3650).optional(),
      notification_days: z.number().int().min(7).max(3650).optional(),
    }).partial().optional(),
  }).strict()

  function mergeTenantSettings(raw: Record<string, any>) {
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      portal: { ...DEFAULT_SETTINGS.portal, ...(raw.portal ?? {}) },
      magic_links: { ...DEFAULT_SETTINGS.magic_links, ...(raw.magic_links ?? {}) },
      ai_triage: { ...DEFAULT_SETTINGS.ai_triage, ...(raw.ai_triage ?? {}) },
      remote_support: { ...DEFAULT_SETTINGS.remote_support, ...(raw.remote_support ?? {}) },
      endpoints: { ...DEFAULT_SETTINGS.endpoints, ...(raw.endpoints ?? {}) },
      monitoring: { ...DEFAULT_SETTINGS.monitoring, ...(raw.monitoring ?? {}) },
      data_retention: { ...DEFAULT_SETTINGS.data_retention, ...(raw.data_retention ?? {}) },
    }
  }

  app.get(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const raw = (rows[0]?.settings ?? {}) as Record<string, any>
      return { settings: mergeTenantSettings(raw) }
    },
  )

  app.patch(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const body = tenantSettingsPatchSchema.parse(request.body || {}) as Record<string, any>
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const current = mergeTenantSettings((rows[0]?.settings ?? {}) as Record<string, any>) as Record<string, any>
      for (const [key, value] of Object.entries(body)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) current[key] = { ...(current[key] ?? {}), ...value }
        else current[key] = value
      }
      const merged = mergeTenantSettings(current)
      await app.db.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [ctx.tenantId, JSON.stringify(merged)])
      reply.code(200)
      return { settings: merged }
    },
  )
}
