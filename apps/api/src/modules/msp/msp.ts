import { AppError } from '../../core/errors.js'
import { roleHasPermission } from '../../core/permissions.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface Branding {
  portalTitle?: string
  logoUrl?: string
  primaryColor?: string
}

export interface BrandingUpdate {
  portalTitle?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
}

export interface MspTenant {
  id: string
  name: string
  slug: string
  region: string
  orgRole: string
  branding: Branding
  stats: {
    openTickets: number
    deviceCount: number
    activeSessions: number
  }
}

function brandingFrom(settings: unknown): Branding {
  const s = (settings ?? {}) as Record<string, unknown>
  const b = (s.branding ?? {}) as Record<string, unknown>
  const out: Branding = {}
  if (typeof b.portalTitle === 'string') out.portalTitle = b.portalTitle
  if (typeof b.logoUrl === 'string') out.logoUrl = b.logoUrl
  if (typeof b.primaryColor === 'string') out.primaryColor = b.primaryColor
  return out
}

/**
 * Cross-tenant console view for MSP technicians: every tenant the caller is an
 * active member of (staff roles only — end_user memberships are excluded) with
 * per-tenant branding and headline stats. Stats are gathered inside per-tenant
 * transactions so row-level security is respected.
 */
export async function mspConsole(pool: DbPool, userId: string): Promise<MspTenant[]> {
  const { rows } = await pool.query(
    `SELECT m.org_role, t.id AS tenant_id, t.slug, t.name, t.region, t.settings
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.status = 'active'
      ORDER BY t.name`,
    [userId],
  )

  const tenants: MspTenant[] = []
  for (const row of rows) {
    if (!roleHasPermission(row.org_role, 'tenant.read')) continue
    const stats = await withTenant(pool, row.tenant_id, async (client) => {
      const open = await client.query(
        `SELECT count(*)::int AS n FROM tickets WHERE status NOT IN ('resolved', 'closed')`,
      )
      const devices = await client.query(`SELECT count(*)::int AS n FROM devices`)
      const sessions = await client.query(
        `SELECT count(*)::int AS n FROM remote_sessions WHERE state IN ('active', 'connecting', 'reconnecting')`,
      )
      return {
        openTickets: open.rows[0].n as number,
        deviceCount: devices.rows[0].n as number,
        activeSessions: sessions.rows[0].n as number,
      }
    })
    tenants.push({
      id: row.tenant_id,
      name: row.name,
      slug: row.slug,
      region: row.region,
      orgRole: row.org_role,
      branding: brandingFrom(row.settings),
      stats,
    })
  }
  return tenants
}

export async function updateBranding(
  pool: DbPool,
  tenantId: string,
  input: BrandingUpdate,
): Promise<Branding> {
  const { rows } = await pool.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])
  if (!rows[0]) throw AppError.notFound('Tenant not found')

  const settings = (rows[0].settings ?? {}) as Record<string, unknown>
  const branding = { ...((settings.branding ?? {}) as Record<string, unknown>) }

  const apply = (key: keyof Branding, value: string | null | undefined) => {
    if (value === undefined) return
    if (value === null || value === '') delete branding[key]
    else branding[key] = value
  }
  apply('portalTitle', input.portalTitle)
  apply('logoUrl', input.logoUrl)
  apply('primaryColor', input.primaryColor)

  settings.branding = branding
  await pool.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [tenantId, JSON.stringify(settings)])
  return brandingFrom(settings)
}
