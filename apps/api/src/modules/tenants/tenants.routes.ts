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
      max_session_duration_minutes: 480,
      inactivity_timeout_minutes: 30,
      file_transfer_limit_mb: 100,
      require_elevated_action_reconsent: true,
      unattended_access_policy: 'approved_devices',
    },
    endpoints: {
      offline_after_minutes: 10,
      heartbeat_interval_seconds: 30,
      allow_self_enrollment: true,
      enrollment_code_expiry_minutes: 15,
      enrollment_approval_required: false,
      automatic_updates: true,
      minimum_agent_version: '',
      personal_device_policy: 'allow_support_only',
      inventory_collection: { hardware: true, software: true, processes: false, services: false, network: true },
      retire_after_offline_days: 90,
    },
    monitoring: {
      create_tickets_by_default: true,
      offline_ticket_mode: 'alert_only',
      default_ticket_priority: 'p3',
      default_severity: 'warning',
      maintenance_windows: [],
      alert_routing: 'on_call_team',
      deduplication_window_minutes: 30,
      recovery_notifications: true,
      escalation_delay_minutes: 30,
      notification_channels: ['in_app'],
    },
    integrations: {
      webhook_events: ['*'],
      webhook_retry_attempts: 3,
      webhook_secret_rotation_days: 90,
      connection_test_timeout_seconds: 10,
      oauth_expiry_warning_days: 14,
    },
    data_retention: {
      audit_days: 365,
      recording_days: 30,
      notification_days: 90,
      ticket_days: 0,
      attachment_days: 0,
      chat_days: 90,
      telemetry_days: 30,
      legal_hold_enabled: false,
      purge_schedule: 'daily',
    },
    storage_quota_mb: 0, // 0 = no limit
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
      max_session_duration_minutes: z.number().int().min(5).max(10080).optional(),
      inactivity_timeout_minutes: z.number().int().min(0).max(1440).optional(),
      file_transfer_limit_mb: z.number().int().min(1).max(2048).optional(),
      require_elevated_action_reconsent: z.boolean().optional(),
      unattended_access_policy: z.enum(['disabled', 'approved_devices', 'all_enrolled_devices']).optional(),
    }).partial().optional(),
    endpoints: z.object({
      offline_after_minutes: z.number().int().min(1).max(1440).optional(),
      heartbeat_interval_seconds: z.number().int().min(10).max(3600).optional(),
      allow_self_enrollment: z.boolean().optional(),
      enrollment_code_expiry_minutes: z.number().int().min(5).max(1440).optional(),
      enrollment_approval_required: z.boolean().optional(),
      automatic_updates: z.boolean().optional(),
      minimum_agent_version: z.string().trim().max(40).optional(),
      personal_device_policy: z.enum(['allow_support_only', 'block_unenrolled', 'allow_all']).optional(),
      inventory_collection: z.object({ hardware: z.boolean().optional(), software: z.boolean().optional(), processes: z.boolean().optional(), services: z.boolean().optional(), network: z.boolean().optional() }).partial().optional(),
      retire_after_offline_days: z.number().int().min(0).max(3650).optional(),
    }).partial().optional(),
    monitoring: z.object({
      create_tickets_by_default: z.boolean().optional(),
      offline_ticket_mode: z.enum(['alert_only', 'ticket']).optional(),
      default_ticket_priority: z.enum(['p1', 'p2', 'p3', 'p4']).optional(),
      default_severity: z.enum(['info', 'warning', 'critical']).optional(),
      maintenance_windows: z.array(z.object({ start: z.string(), end: z.string() })).max(100).optional(),
      alert_routing: z.enum(['on_call_team', 'service_desk', 'managers', 'custom']).optional(),
      deduplication_window_minutes: z.number().int().min(0).max(10080).optional(),
      recovery_notifications: z.boolean().optional(),
      escalation_delay_minutes: z.number().int().min(0).max(10080).optional(),
      notification_channels: z.array(z.enum(['in_app', 'email', 'push', 'webhook'])).max(10).optional(),
    }).partial().optional(),
    integrations: z.object({
      webhook_events: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
      webhook_retry_attempts: z.number().int().min(1).max(10).optional(),
      webhook_secret_rotation_days: z.number().int().min(1).max(3650).optional(),
      connection_test_timeout_seconds: z.number().int().min(1).max(120).optional(),
      oauth_expiry_warning_days: z.number().int().min(1).max(365).optional(),
    }).partial().optional(),
    data_retention: z.object({
      audit_days: z.number().int().min(30).max(3650).optional(),
      recording_days: z.number().int().min(1).max(3650).optional(),
      notification_days: z.number().int().min(7).max(3650).optional(),
      ticket_days: z.number().int().min(0).max(3650).optional(),
      attachment_days: z.number().int().min(0).max(3650).optional(),
      chat_days: z.number().int().min(0).max(3650).optional(),
      telemetry_days: z.number().int().min(0).max(3650).optional(),
      legal_hold_enabled: z.boolean().optional(),
      purge_schedule: z.enum(['manual', 'daily', 'weekly']).optional(),
    }).partial().optional(),
    storage_quota_mb: z.number().int().min(0).max(1024000).optional(),
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

  /** Render the exact portal invitation email without sending it. */
  app.post(
    '/tenant/settings/portal/invite/preview',
    { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const body = inviteSchema.parse(request.body)
      const { rows } = await app.db.query('SELECT name, slug, settings FROM tenants WHERE id = $1', [ctx.tenantId])
      const tenant = rows[0]
      const settings = mergeTenantSettings((tenant?.settings ?? {}) as Record<string, unknown>) as Record<string, unknown>
      const portal = settings.portal as Record<string, unknown>
      const branding = (settings.branding ?? {}) as Record<string, unknown>
      const portalSlug = String(portal.slug || tenant?.slug || ctx.slug)
      const portalUrl = `${app.config.publicUrl.replace(/\/$/, '')}/portal/${encodeURIComponent(portalSlug)}`
      const mail = app.mailer.buildPortalInviteMail({
        to: body.to.split(/[,\\n;]+/)[0]?.trim() || 'preview@example.com',
        tenantName: safeTenantName(tenant?.name as string | undefined),
        portalUrl,
        senderName: ctx.name,
        message: body.message,
        brand: {
          logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
          primaryColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : null,
        },
      })
      return { subject: mail.subject, text: mail.text, html: mail.html }
    },
  )

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
      const settings = mergeTenantSettings(raw) as Record<string, unknown>
      const branding = (settings.branding ?? {}) as Record<string, unknown>
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
          brand: {
            logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : null,
            primaryColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : null,
          },
        })
        const jobId = await app.emailQueue.addAndSend(mail)
        jobIds.push(jobId)
        try {
          await app.db.query(
            `INSERT INTO portal_invitation_history (tenant_id, sent_by, recipient_email, portal_url, personal_message, delivery_status, job_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [ctx.tenantId, ctx.userId, email, portalUrl, body.message ?? '', app.mailer.enabled ? 'sent' : 'not_configured', jobId],
          )
        } catch (error) {
          // Keep invitations functional during rolling deploys where the new
          // history migration has not run yet; the history endpoint will fill
          // in once the schema is available.
          app.log.warn({ error, tenantId: ctx.tenantId }, 'Portal invitation history is unavailable')
        }
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

  app.get('/tenant/settings/portal/invite/history', { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    try {
      const { rows } = await app.db.query(
        `SELECT h.id, h.recipient_email, h.portal_url, h.personal_message, h.delivery_status, h.job_id, h.created_at, u.name AS sent_by_name
           FROM portal_invitation_history h LEFT JOIN users u ON u.id = h.sent_by
          WHERE h.tenant_id = $1 ORDER BY h.created_at DESC LIMIT 50`,
        [ctx.tenantId],
      )
      return { invitations: rows }
    } catch (error) {
      app.log.warn({ error, tenantId: ctx.tenantId }, 'Portal invitation history is unavailable')
      return { invitations: [] }
    }
  })

  // ── Storage usage ──────────────────────────────────────────────────────
  app.get(
    '/tenant/storage',
    { preHandler: [authenticate, requireTenant, requirePermission('tenant.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const { rows } = await app.db.query(
        'SELECT storage_bytes, settings FROM tenants WHERE id = $1',
        [ctx.tenantId],
      )
      const row = rows[0]
      const storageBytes = Number(row?.storage_bytes ?? 0)
      const settings = (row?.settings ?? {}) as Record<string, unknown>
      const quotaMb = Number(settings.storage_quota_mb ?? 0)
      const quotaBytes = quotaMb > 0 ? quotaMb * 1024 * 1024 : 0
      return {
        storageBytes,
        quotaMb,
        quotaBytes,
        usagePercent: quotaBytes > 0 ? Math.round((storageBytes / quotaBytes) * 10000) / 100 : 0,
        withinQuota: quotaBytes === 0 || storageBytes < quotaBytes,
      }
    },
  )
}

function safeTenantName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, 120) || 'ReyDesk'
}
