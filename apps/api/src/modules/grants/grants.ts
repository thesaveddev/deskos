import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export const GRANTABLE_PERMISSIONS = [
  'remote.elevated',
  'remote.control',
  'remote.attended',
  'remote.unattended',
  'remote.inspection',
  'script.execute',
] as const

export type GrantablePermission = (typeof GRANTABLE_PERMISSIONS)[number]

export const GRANT_STATUSES = ['pending', 'approved', 'denied', 'revoked', 'expired', 'active'] as const
export type GrantStatus = (typeof GRANT_STATUSES)[number]

export const GRANT_SCOPES = ['tenant', 'device_group', 'device'] as const
export type GrantScope = (typeof GRANT_SCOPES)[number]

export interface CreateGrantInput {
  granteeId?: string
  permission: GrantablePermission
  scopeType: GrantScope
  scopeId?: string
  reason: string
  expiresAt: string
}

export interface GrantRow {
  id: string
  tenant_id: string
  subject_type: string
  subject_id: string
  permission: string
  scope_type: string
  scope_id: string | null
  granted_by: string | null
  expires_at: string
  reason: string
  status: GrantStatus
  requested_by: string | null
  approved_at: string | null
  denied_at: string | null
  revoked_at: string | null
  checked_out_at: string | null
  checked_in_at: string | null
  created_at: string
  updated_at: string
  grantee_name: string | null
  requested_by_name: string | null
  effective_status: GrantStatus
}

async function assertActiveMember(client: import('pg').PoolClient, tenantId: string, userId: string): Promise<void> {
  const { rows } = await client.query(
    'SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3',
    [tenantId, userId, 'active'],
  )
  if (!rows[0]) throw AppError.badRequest('Grantee must be an active member of this tenant', 'invalid_grantee')
}

async function assertScopeExists(
  client: import('pg').PoolClient,
  scopeType: GrantScope,
  scopeId: string,
): Promise<void> {
  if (scopeType === 'device') {
    const { rows } = await client.query('SELECT 1 FROM devices WHERE id = $1', [scopeId])
    if (!rows[0]) throw AppError.notFound('Device not found')
  } else if (scopeType === 'device_group') {
    const { rows } = await client.query('SELECT 1 FROM device_groups WHERE id = $1', [scopeId])
    if (!rows[0]) throw AppError.notFound('Device group not found')
  }
}

function effectiveStatus(row: { status: GrantStatus; expires_at: string }): GrantStatus {
  if ((row.status === 'active' || row.status === 'approved') && new Date(row.expires_at).getTime() <= Date.now()) {
    return 'expired'
  }
  return row.status
}

export async function createGrant(
  pool: DbPool,
  tenantId: string,
  input: CreateGrantInput,
  requesterId: string,
): Promise<GrantRow> {
  const granteeId = input.granteeId ?? requesterId
  if (new Date(input.expiresAt).getTime() <= Date.now()) {
    throw AppError.badRequest('Expiry must be in the future', 'invalid_expiry')
  }
  return withTenant(pool, tenantId, async (client) => {
    await assertActiveMember(client, tenantId, granteeId)
    if (input.scopeType !== 'tenant') {
      if (!input.scopeId) throw AppError.badRequest('A scope id is required', 'scope_id_required')
      await assertScopeExists(client, input.scopeType, input.scopeId)
    }
    const { rows } = await client.query(
      `INSERT INTO grants
         (tenant_id, subject_type, subject_id, permission, scope_type, scope_id, reason, expires_at, requested_by, status)
       VALUES ($1, 'user', $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING *`,
      [tenantId, granteeId, input.permission, input.scopeType, input.scopeId ?? null, input.reason, new Date(input.expiresAt), requesterId],
    )
    return rows[0] as GrantRow
  })
}

export async function listGrants(
  pool: DbPool,
  tenantId: string,
  filters: { status?: GrantStatus; mine?: string },
): Promise<GrantRow[]> {
  return withTenant(pool, tenantId, async (client) => {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status) {
      params.push(filters.status)
      where.push(`g.status = $${params.length}`)
    }
    if (filters.mine) {
      params.push(filters.mine)
      where.push(`g.subject_id = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT g.*, u.name AS grantee_name, r.name AS requested_by_name
         FROM grants g
         LEFT JOIN users u ON u.id = g.subject_id
         LEFT JOIN users r ON r.id = g.requested_by
         ${whereSql}
        ORDER BY g.created_at DESC
        LIMIT 200`,
      params,
    )
    return rows.map((row: GrantRow) => ({ ...row, effective_status: effectiveStatus(row) }))
  })
}

async function getGrant(client: import('pg').PoolClient, id: string): Promise<GrantRow> {
  const { rows } = await client.query('SELECT * FROM grants WHERE id = $1', [id])
  if (!rows[0]) throw AppError.notFound('Grant not found')
  return rows[0] as GrantRow
}

export async function approveGrant(pool: DbPool, tenantId: string, id: string, approverId: string): Promise<GrantRow> {
  return withTenant(pool, tenantId, async (client) => {
    const grant = await getGrant(client, id)
    if (grant.status !== 'pending') throw AppError.badRequest('Only pending grants can be approved', 'invalid_status')
    if (new Date(grant.expires_at).getTime() <= Date.now()) throw AppError.badRequest('Grant has already expired', 'grant_expired')
    const { rows } = await client.query(
      `UPDATE grants SET status = 'approved', granted_by = $2, approved_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, approverId],
    )
    return rows[0] as GrantRow
  })
}

export async function denyGrant(pool: DbPool, tenantId: string, id: string, approverId: string): Promise<GrantRow> {
  return withTenant(pool, tenantId, async (client) => {
    const grant = await getGrant(client, id)
    if (grant.status !== 'pending') throw AppError.badRequest('Only pending grants can be denied', 'invalid_status')
    const { rows } = await client.query(
      `UPDATE grants SET status = 'denied', granted_by = $2, denied_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, approverId],
    )
    return rows[0] as GrantRow
  })
}

export async function revokeGrant(pool: DbPool, tenantId: string, id: string, approverId: string): Promise<GrantRow> {
  return withTenant(pool, tenantId, async (client) => {
    const grant = await getGrant(client, id)
    if (grant.status === 'denied' || grant.status === 'revoked' || grant.status === 'expired') {
      throw AppError.badRequest('Grant is already in a terminal state', 'invalid_status')
    }
    const { rows } = await client.query(
      `UPDATE grants SET status = 'revoked', granted_by = $2, revoked_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id, approverId],
    )
    return rows[0] as GrantRow
  })
}

export async function checkoutGrant(pool: DbPool, tenantId: string, id: string, userId: string): Promise<GrantRow> {
  return withTenant(pool, tenantId, async (client) => {
    const grant = await getGrant(client, id)
    if (grant.subject_id !== userId) throw AppError.forbidden('You can only check out your own grants')
    if (grant.status !== 'approved') throw AppError.badRequest('Only approved grants can be checked out', 'invalid_status')
    if (new Date(grant.expires_at).getTime() <= Date.now()) throw AppError.badRequest('Grant has already expired', 'grant_expired')
    const { rows } = await client.query(
      `UPDATE grants SET status = 'active', checked_out_at = now(), checked_in_at = NULL, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0] as GrantRow
  })
}

export async function checkinGrant(pool: DbPool, tenantId: string, id: string, userId: string): Promise<GrantRow> {
  return withTenant(pool, tenantId, async (client) => {
    const grant = await getGrant(client, id)
    if (grant.subject_id !== userId) throw AppError.forbidden('You can only check in your own grants')
    if (grant.status !== 'active') throw AppError.badRequest('Only active grants can be checked in', 'invalid_status')
    const { rows } = await client.query(
      `UPDATE grants SET status = 'approved', checked_in_at = now(), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0] as GrantRow
  })
}

/**
 * True when the user holds a checked-out, unexpired grant for `permission`
 * whose scope matches the given device (tenant-wide, the device itself, or the
 * device's group). This is the enforcement point for JIT privileged access.
 */
export async function hasActiveGrant(
  pool: DbPool,
  tenantId: string,
  userId: string,
  permission: GrantablePermission,
  deviceId?: string,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    let groupId: string | null = null
    if (deviceId) {
      const device = (await client.query('SELECT group_id FROM devices WHERE id = $1', [deviceId])).rows[0]
      groupId = device?.group_id ?? null
    }
    const { rows } = await client.query(
      `SELECT 1 FROM grants
        WHERE tenant_id = $1 AND subject_type = 'user' AND subject_id = $2
          AND permission = $3 AND status = 'active' AND expires_at > now()
          AND (
            scope_type = 'tenant'
            OR (scope_type = 'device' AND scope_id = $4)
            OR (scope_type = 'device_group' AND scope_id = $5)
          )
        LIMIT 1`,
      [tenantId, userId, permission, deviceId ?? null, groupId],
    )
    return rows.length > 0
  })
}
