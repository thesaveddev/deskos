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
               AND ($2 = 'required' OR ($2 = 'admin_only' AND m.org_role IN ('owner', 'it_manager', 'service_desk_manager')))
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
               AND ($2 = 'required' OR ($2 = 'admin_only' AND m.org_role IN ('owner', 'it_manager', 'service_desk_manager')))
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
      // Self-service registration: when enabled, anyone (subject to
      // registration_domains) can create an end-user account at the portal.
      allow_registration: false,
      // Empty = any email domain may register when allow_registration is on.
      registration_domains: [],
      // Short greeting shown on the portal home page.
      welcome_message: '',
      // Empty = use the organisation slug for the portal URL path.
      slug: '',
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
      allow_registration: z.boolean().optional(),
      registration_domains: z.array(z.string().trim().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/).max(253)).max(25).optional(),
      welcome_message: z.string().max(500).optional(),
      slug: z.string().trim().max(64).regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/).optional(),
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

  function mergeTenantSettings(raw: Record<string, unknown>) {
    const section = (key: string): Record<string, unknown> => (raw[key] as Record<string, unknown> | undefined) ?? {}
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      portal: { ...DEFAULT_SETTINGS.portal, ...section('portal') },
      magic_links: { ...DEFAULT_SETTINGS.magic_links, ...section('magic_links') },
      ai_triage: { ...DEFAULT_SETTINGS.ai_triage, ...section('ai_triage') },
      remote_support: { ...DEFAULT_SETTINGS.remote_support, ...section('remote_support') },
      endpoints: { ...DEFAULT_SETTINGS.endpoints, ...section('endpoints') },
      monitoring: { ...DEFAULT_SETTINGS.monitoring, ...section('monitoring') },
      data_retention: { ...DEFAULT_SETTINGS.data_retention, ...section('data_retention') },
    }
  }

  app.get(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query('SELECT settings, slug FROM tenants WHERE id = $1', [ctx.tenantId])
      const raw = (rows[0]?.settings ?? {}) as Record<string, unknown>
      const settings = mergeTenantSettings(raw)
      const tenantSlug = rows[0]?.slug as string | undefined
      const portalSlug = String(((settings.portal as Record<string, unknown> | undefined)?.slug ?? '')).trim() || tenantSlug || ctx.slug
      return {
        settings,
        portal: {
          slug: portalSlug,
          url: `${app.config.publicUrl.replace(/\/$/, '')}/portal/${encodeURIComponent(portalSlug)}`,
        },
      }
    },
  )

  app.patch(
    '/tenant/settings',
    { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const body = tenantSettingsPatchSchema.parse(request.body || {}) as Record<string, unknown>
      const { rows } = await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const current = mergeTenantSettings((rows[0]?.settings ?? {}) as Record<string, unknown>) as Record<string, unknown>
      for (const [key, value] of Object.entries(body)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          current[key] = { ...(current[key] as Record<string, unknown> ?? {}), ...(value as Record<string, unknown>) }
        } else {
          current[key] = value
        }
      }
      const merged = mergeTenantSettings(current)
      await app.db.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [ctx.tenantId, JSON.stringify(merged)])
      const tenantSlug = rows[0]?.slug as string | undefined
      const portalSlug = String(((merged.portal as Record<string, unknown> | undefined)?.slug ?? '')).trim() || tenantSlug || ctx.slug
      reply.code(200)
      return {
        settings: merged,
        portal: {
          slug: portalSlug,
          url: `${app.config.publicUrl.replace(/\/$/, '')}/portal/${encodeURIComponent(portalSlug)}`,
        },
      }
    },
  )

  const inviteSchema = z.object({
    // Comma- or newline-separated list of recipient addresses.
    to: z.string().trim().min(3).max(4000),
    message: z.string().trim().max(2000).optional(),
  })

  /** Send shareable portal-invitation emails to one or more addresses. */
  app.post(
    '/tenant/settings/portal/invite',
    { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const body = inviteSchema.parse(request.body)
      const emails = body.to
        .split(/[,\n;]+/)
        .map((address) => address.trim().toLowerCase())
        .filter(Boolean)
      if (emails.length === 0) {
        throw new AppError(400, 'invalid_recipients', 'Provide at least one recipient email address.')
      }
      for (const email of emails) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          throw new AppError(400, 'invalid_recipients', `“${email}” is not a valid email address.`)
        }
      }

      const { rows } = await app.db.query('SELECT name, slug, settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const tenant = rows[0]
      const raw = (tenant?.settings ?? {}) as Record<string, unknown>
      const settings = mergeTenantSettings(raw)
      const tenantSlug = tenant?.slug as string | undefined
      const portalSlug = String(((settings.portal as Record<string, unknown> | undefined)?.slug ?? '')).trim() || tenantSlug || ctx.slug
      const portalUrl = `${app.config.publicUrl.replace(/\/$/, '')}/portal/${encodeURIComponent(portalSlug)}`
      const tenantName = safeTenantName(tenant?.name as string | undefined)

      const senderResult = await app.db.query(
        `SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.status = 'active'`,
        [ctx.tenantId, ctx.userId],
      )
      const senderName = (senderResult.rows[0]?.name as string | undefined)?.trim() || undefined

      const unique = [...new Set(emails)]
      const jobIds: string[] = []
      let delivered = 0
      for (const email of unique) {
        const mail = app.mailer.buildPortalInviteMail({
          to: email,
          tenantName,
          portalUrl,
          senderName,
          message: body.message,
        })
        const jobId = await app.emailQueue.addAndSend(mail)
        jobIds.push(jobId)
        if (app.mailer.enabled) delivered += 1
      }
      app.log.info({ tenantId: ctx.tenantId, recipients: unique.length, jobIds }, 'Portal invitation emails queued')

      reply.code(200)
      return {
        ok: true,
        recipients: unique.length,
        delivered,
        mailConfigured: app.mailer.enabled,
        portalUrl,
      }
    },
  )
}

function safeTenantName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, 120) || 'ReyDesk'
}
