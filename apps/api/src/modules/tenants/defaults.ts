import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface TenantDefaults {
  businessHoursId: string
  slaPolicyId: string
  categoryId: string
  teamId: string
}

export const DEFAULT_SLA_MATRIX = {
  p1: { response_mins: 30, resolution_mins: 240 },
  p2: { response_mins: 60, resolution_mins: 480 },
  p3: { response_mins: 240, resolution_mins: 1440 },
  p4: { response_mins: 480, resolution_mins: 4320 },
} as const

/**
 * Idempotently ensure the baseline configuration exists for a tenant:
 * default business hours (24/7), default SLA policy, a General category and a
 * Service Desk team. Safe to call on every tenant-touching flow.
 */
export async function ensureTenantDefaults(pool: DbPool, tenantId: string): Promise<TenantDefaults> {
  return withTenant(pool, tenantId, async (client) => {
    const bh = await client.query(
      `INSERT INTO business_hours (tenant_id, name, schedule)
       SELECT $1, 'Default', '{}'::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM business_hours WHERE tenant_id = $1)
       RETURNING id`,
      [tenantId],
    )
    const businessHoursId: string =
      bh.rows[0]?.id ??
      (await client.query('SELECT id FROM business_hours WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0].id

    const pol = await client.query(
      `INSERT INTO sla_policies (tenant_id, name, business_hours_id, is_default, matrix)
       SELECT $1, 'Default', $2, true, $3::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM sla_policies WHERE tenant_id = $1)
       RETURNING id`,
      [tenantId, businessHoursId, JSON.stringify(DEFAULT_SLA_MATRIX)],
    )
    const slaPolicyId: string =
      pol.rows[0]?.id ??
      (await client.query('SELECT id FROM sla_policies WHERE tenant_id = $1 ORDER BY is_default DESC LIMIT 1', [tenantId])).rows[0].id

    const cat = await client.query(
      `INSERT INTO categories (tenant_id, name)
       SELECT $1, 'General'
        WHERE NOT EXISTS (SELECT 1 FROM categories WHERE tenant_id = $1)
       RETURNING id`,
      [tenantId],
    )
    const categoryId: string =
      cat.rows[0]?.id ??
      (await client.query('SELECT id FROM categories WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0].id

    const team = await client.query(
      `INSERT INTO teams (tenant_id, name)
       SELECT $1, 'Service Desk'
        WHERE NOT EXISTS (SELECT 1 FROM teams WHERE tenant_id = $1)
       RETURNING id`,
      [tenantId],
    )
    const teamId: string =
      team.rows[0]?.id ??
      (await client.query('SELECT id FROM teams WHERE tenant_id = $1 LIMIT 1', [tenantId])).rows[0].id

    return { businessHoursId, slaPolicyId, categoryId, teamId }
  })
}

export async function getDefaultSlaPolicy(pool: DbPool, tenantId: string): Promise<{ id: string; matrix: Record<string, { response_mins: number; resolution_mins: number }>; businessHoursSchedule: Record<string, { start: string; end: string }> }> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT p.id, p.matrix, COALESCE(b.schedule, '{}'::jsonb) AS schedule
         FROM sla_policies p
         LEFT JOIN business_hours b ON b.id = p.business_hours_id
        WHERE p.tenant_id = $1
        ORDER BY p.is_default DESC, p.created_at ASC
        LIMIT 1`,
      [tenantId],
    )
    if (!rows[0]) throw new Error('No SLA policy found for tenant')
    return { id: rows[0].id, matrix: rows[0].matrix, businessHoursSchedule: rows[0].schedule }
  })
}
