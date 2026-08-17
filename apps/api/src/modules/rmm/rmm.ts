import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export const DEVICE_ACTIONS = ['restart', 'run_script', 'collect_inventory'] as const
export type DeviceAction = (typeof DEVICE_ACTIONS)[number]

export const ACTION_STATUSES = ['pending', 'dispatched', 'succeeded', 'failed', 'cancelled'] as const
export type ActionStatus = (typeof ACTION_STATUSES)[number]

export interface InventoryInput {
  hardware?: Record<string, unknown>
  os?: Record<string, unknown>
  apps?: unknown[]
  securityPosture?: Record<string, unknown>
}

export interface PolicyInput {
  name: string
  groupId?: string | null
  postureChecks?: unknown[]
  rebootWindow?: Record<string, unknown>
  enabled?: boolean
}

export interface CreateActionsInput {
  action: DeviceAction
  payload?: Record<string, unknown>
  deviceIds?: string[]
  groupId?: string
}

export async function upsertInventory(
  pool: DbPool,
  tenantId: string,
  deviceId: string,
  input: InventoryInput,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE devices SET last_seen_at = now() WHERE id = $1 AND tenant_id = $2`,
      [deviceId, tenantId],
    )
    const { rows } = await client.query(
      `INSERT INTO device_inventory (tenant_id, device_id, hardware, os, apps, security_posture)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb)
       ON CONFLICT (device_id) DO UPDATE
         SET hardware = EXCLUDED.hardware, os = EXCLUDED.os, apps = EXCLUDED.apps,
             security_posture = EXCLUDED.security_posture, collected_at = now(), updated_at = now()
       RETURNING *`,
      [tenantId, deviceId, JSON.stringify(input.hardware ?? {}), JSON.stringify(input.os ?? {}), JSON.stringify(input.apps ?? []), JSON.stringify(input.securityPosture ?? {})],
    )
    return rows[0]
  })
}

export async function getInventory(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM device_inventory WHERE device_id = $1', [deviceId])
    if (!rows[0]) throw AppError.notFound('No inventory reported for this device')
    return rows[0]
  })
}

export async function listPolicies(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT p.*, g.name AS group_name
         FROM endpoint_policies p
         LEFT JOIN device_groups g ON g.id = p.group_id
        ORDER BY p.created_at`,
    )
    return rows
  })
}

export async function createPolicy(pool: DbPool, tenantId: string, input: PolicyInput, actorId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    if (input.groupId) {
      const grp = await client.query('SELECT 1 FROM device_groups WHERE id = $1', [input.groupId])
      if (!grp.rows[0]) throw AppError.notFound('Device group not found')
    }
    const { rows } = await client.query(
      `INSERT INTO endpoint_policies (tenant_id, name, group_id, posture_checks, reboot_window, enabled, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7) RETURNING *`,
      [tenantId, input.name, input.groupId ?? null, JSON.stringify(input.postureChecks ?? []), JSON.stringify(input.rebootWindow ?? {}), input.enabled ?? true, actorId],
    )
    return rows[0]
  })
}

export async function updatePolicy(pool: DbPool, tenantId: string, id: string, input: Partial<PolicyInput>): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = await client.query('SELECT id FROM endpoint_policies WHERE id = $1', [id])
    if (!existing.rows[0]) throw AppError.notFound('Policy not found')
    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.groupId !== undefined) push('group_id', input.groupId)
    if (input.postureChecks !== undefined) push('posture_checks', JSON.stringify(input.postureChecks))
    if (input.rebootWindow !== undefined) push('reboot_window', JSON.stringify(input.rebootWindow))
    if (input.enabled !== undefined) push('enabled', input.enabled)
    push('updated_at', new Date())
    params.push(id)
    const { rows } = await client.query(`UPDATE endpoint_policies SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params)
    return rows[0]
  })
}

export async function deletePolicy(pool: DbPool, tenantId: string, id: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('DELETE FROM endpoint_policies WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) throw AppError.notFound('Policy not found')
  })
}

export async function createActions(
  pool: DbPool,
  tenantId: string,
  input: CreateActionsInput,
  actorId: string,
): Promise<{ created: number; actionIds: string[] }> {
  return withTenant(pool, tenantId, async (client) => {
    let deviceIds: string[]
    if (input.groupId) {
      const { rows } = await client.query('SELECT id FROM devices WHERE group_id = $1', [input.groupId])
      deviceIds = rows.map((r) => r.id as string)
    } else if (input.deviceIds?.length) {
      deviceIds = input.deviceIds
    } else {
      throw AppError.badRequest('Provide deviceIds or a groupId', 'target_required')
    }
    if (deviceIds.length === 0) throw AppError.badRequest('No devices matched the target', 'empty_target')

    const actionIds: string[] = []
    for (const deviceId of deviceIds) {
      const { rows } = await client.query(
        `INSERT INTO device_actions (tenant_id, device_id, action, payload, requested_by)
         VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
        [tenantId, deviceId, input.action, JSON.stringify(input.payload ?? {}), actorId],
      )
      actionIds.push(rows[0].id as string)
    }
    return { created: actionIds.length, actionIds }
  })
}

export async function listActions(pool: DbPool, tenantId: string, filters: { status?: ActionStatus; deviceId?: string } = {}): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status) {
      params.push(filters.status)
      where.push(`a.status = $${params.length}`)
    }
    if (filters.deviceId) {
      params.push(filters.deviceId)
      where.push(`a.device_id = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT a.*, d.name AS device_name, u.name AS requested_by_name
         FROM device_actions a
         JOIN devices d ON d.id = a.device_id
         LEFT JOIN users u ON u.id = a.requested_by
         ${whereSql}
        ORDER BY a.created_at DESC
        LIMIT 200`,
      params,
    )
    return rows
  })
}

export async function pendingActionsForDevice(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, action, payload FROM device_actions
        WHERE device_id = $1 AND status = 'pending'
        ORDER BY created_at
        LIMIT 50`,
      [deviceId],
    )
    // Mark returned actions dispatched atomically.
    for (const row of rows) {
      await client.query(`UPDATE device_actions SET status = 'dispatched', dispatched_at = now() WHERE id = $1`, [row.id])
    }
    return rows
  })
}

export async function reportActionResult(
  pool: DbPool,
  tenantId: string,
  actionId: string,
  deviceId: string,
  input: { status: 'succeeded' | 'failed'; result?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE device_actions SET status = $4, result = $5::jsonb, completed_at = now()
        WHERE id = $1 AND device_id = $2 AND tenant_id = $3 AND status IN ('pending', 'dispatched')
        RETURNING *`,
      [actionId, deviceId, tenantId, input.status, JSON.stringify(input.result ?? {})],
    )
    if (!rows[0]) throw AppError.notFound('Action not found or already completed')
    return rows[0]
  })
}
