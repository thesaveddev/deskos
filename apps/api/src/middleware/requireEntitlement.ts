import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../core/errors.js'
import { withTenant, type DbPool } from '../db/pool.js'
import { expireTrialIfDue } from '../modules/billing/billing.service.js'

/**
 * Entitlement guard – enforces plan limits (technicians, devices) at the API
 * boundary.  Attach as a `preHandler` on routes that increase usage:
 *
 *   - POST /members/invite      → requireEntitlement('technicians')
 *   - POST /devices/:id/...     → requireEntitlement('devices')
 *
 * The guard:
 *  1. Loads the tenant's active subscription and its plan limits.
 *  2. Counts current usage (active technicians or non-adhoc devices).
 *  3. Throws 403 with a clear `plan_limit_exceeded` code when the limit
 *     has been reached.
 *
 * Paid plans enforce their published limits. Tenants without a subscription
 * run on the no-card Free experience and are capped at the Free tier
 * (FREE_CAPS), so marketing and enforcement always agree.
 */

const FREE_CAPS = { technicians: 3, devices: 100 }

type EntitlementType = 'technicians' | 'devices'

export function requireEntitlement(type: EntitlementType) {
  return async function entitlementGuard(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const tenantId = request.tenantCtx?.tenantId
    if (!tenantId) return // requireTenant should run first

    const result = await resolvePlan(request.server.db, tenantId)
    const limit = type === 'technicians' ? result.max_technicians : result.max_devices
    const current = await countUsage(request.server.db, tenantId, type)

    if (limit >= 0 && current >= limit) {
      // AppError.forbidden hard-codes `permission_denied`; entitlement failures
      // need their own code so clients can offer an upgrade path.
      throw new AppError(
        403,
        'plan_limit_exceeded',
        `${type === 'technicians' ? 'Technician' : 'Device'} limit reached (${current}/${limit}) on the ${result.name} plan. Upgrade to add more.`,
      )
    }
  }
}

/**
 * Return current plan info for the subscription overview.
 * Used by the billing settings page and internal checks.
 */
export async function getEntitlementInfo(db: DbPool, tenantId: string): Promise<{
  planName: string
  planSlug: string
  maxTechnicians: number
  maxDevices: number
  currentTechnicians: number
  currentDevices: number
  techniciansRemaining: number
  devicesRemaining: number
}> {
  const plan = await resolvePlan(db, tenantId)
  const [technicians, devices] = await Promise.all([
    countUsage(db, tenantId, 'technicians'),
    countUsage(db, tenantId, 'devices'),
  ])
  const maxTech = plan.hasSubscription ? (plan.max_technicians || FREE_CAPS.technicians) : FREE_CAPS.technicians
  const maxDev = plan.hasSubscription ? (plan.max_devices || FREE_CAPS.devices) : FREE_CAPS.devices
  return {
    planName: plan.name,
    planSlug: plan.slug,
    maxTechnicians: maxTech,
    maxDevices: maxDev,
    currentTechnicians: technicians,
    currentDevices: devices,
    techniciansRemaining: Math.max(0, maxTech - technicians),
    devicesRemaining: Math.max(0, maxDev - devices),
  }
}

// ── Internal helpers ──

async function resolvePlan(
  db: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
): Promise<{ name: string; slug: string; max_technicians: number; max_devices: number; hasSubscription: boolean }> {
  // A trial that has run out must not keep granting Pro limits: settle it
  // before reading, so this path always sees the true post-trial state.
  await expireTrialIfDue(db as unknown as DbPool, tenantId)
  const rows = (await db.query(
    `SELECT p.name, p.slug, p.max_technicians, p.max_devices
       FROM tenant_subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.tenant_id = $1 AND s.status IN ('active', 'trialing')
      ORDER BY s.created_at DESC LIMIT 1`,
    [tenantId],
  )).rows
  if (!rows[0]) {
    return { name: 'Free', slug: 'free', max_technicians: FREE_CAPS.technicians, max_devices: FREE_CAPS.devices, hasSubscription: false }
  }
  const r = rows[0]
  return {
    name: String(r.name),
    slug: String(r.slug),
    max_technicians: Number(r.max_technicians) || FREE_CAPS.technicians,
    max_devices: Number(r.max_devices) || FREE_CAPS.devices,
    hasSubscription: true,
  }
}

async function countUsage(
  db: DbPool,
  tenantId: string,
  type: EntitlementType,
): Promise<number> {
  if (type === 'technicians') {
    // Staff members who count toward the cap: active members with
    // technician-relevant roles (everything except portal-only 'customer')
    // plus pending invitations — an over-invited workspace must not slip
    // past the cap by inviting first and accepting later.
    const rows = (await db.query(
      `SELECT count(*)::int AS n FROM memberships
        WHERE tenant_id = $1
          AND status IN ('active', 'invited')
          AND org_role <> 'customer'`,
      [tenantId],
    )).rows
    return Number(rows[0]?.n ?? 0)
  }
  // Devices: non-adhoc enrolled devices. The devices table uses FORCE row
  // security with a missing-ok tenant policy, so a plain pool query outside
  // the tenant transaction sees zero rows — count inside withTenant.
  return withTenant(db, tenantId, async (client) => {
    const rows = (await client.query(
      `SELECT count(*)::int AS n FROM devices WHERE tenant_id = $1 AND adhoc = false`,
      [tenantId],
    )).rows
    return Number(rows[0]?.n ?? 0)
  })
}
