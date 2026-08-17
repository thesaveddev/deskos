import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export const PATCH_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rolling_out',
  'paused',
  'completed',
  'rejected',
  'rolled_back',
] as const
export type PatchStatus = (typeof PATCH_STATUSES)[number]

export const DEVICE_PATCH_STATUSES = ['pending', 'offered', 'downloading', 'applying', 'succeeded', 'failed', 'rolled_back'] as const
export type DevicePatchStatus = (typeof DEVICE_PATCH_STATUSES)[number]

export interface PatchRing {
  name: string
  percent: number
}

export interface CreateDeploymentInput {
  name: string
  version: string
  description?: string
  artifactUrl: string
  sha256: string
  signature?: string
  channel?: 'stable' | 'beta'
  scopeType?: 'tenant' | 'device_group'
  scopeId?: string
  rings?: PatchRing[]
}

function ringForDevice(deviceId: string, rings: PatchRing[]): number {
  const bucket = parseInt(deviceId.replace(/-/g, '').slice(0, 2), 16) % 100
  let cumulative = 0
  for (let i = 0; i < rings.length; i += 1) {
    cumulative += rings[i].percent
    if (bucket < cumulative) return i
  }
  return rings.length - 1
}

async function getDeploymentRow(client: import('pg').PoolClient, id: string): Promise<Record<string, unknown>> {
  const { rows } = await client.query('SELECT * FROM patch_deployments WHERE id = $1', [id])
  if (!rows[0]) throw AppError.notFound('Patch deployment not found')
  return rows[0]
}

export async function createDeployment(
  pool: DbPool,
  tenantId: string,
  input: CreateDeploymentInput,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    if (input.scopeType === 'device_group' && input.scopeId) {
      const grp = await client.query('SELECT 1 FROM device_groups WHERE id = $1', [input.scopeId])
      if (!grp.rows[0]) throw AppError.notFound('Device group not found')
    }
    const rings = input.rings ?? [
      { name: 'Ring 1', percent: 10 },
      { name: 'Ring 2', percent: 40 },
      { name: 'Ring 3', percent: 50 },
    ]
    const { rows } = await client.query(
      `INSERT INTO patch_deployments
         (tenant_id, name, version, description, artifact_url, sha256, signature, channel, status, scope_type, scope_id, rings, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $10, $11::jsonb, $12)
       RETURNING *`,
      [
        tenantId,
        input.name,
        input.version,
        input.description ?? '',
        input.artifactUrl,
        input.sha256,
        input.signature ?? '',
        input.channel ?? 'stable',
        input.scopeType ?? 'tenant',
        input.scopeId ?? null,
        JSON.stringify(rings),
        actorId,
      ],
    )
    return rows[0]
  })
}

export async function listDeployments(
  pool: DbPool,
  tenantId: string,
  filters: { status?: PatchStatus } = {},
): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const params: unknown[] = []
    const where: string[] = []
    if (filters.status) {
      params.push(filters.status)
      where.push(`d.status = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT d.id, d.name, d.version, d.channel, d.status, d.scope_type, d.scope_id, d.rings,
              d.created_at, d.started_at, d.completed_at,
              (SELECT count(*)::int FROM patch_device_status s WHERE s.deployment_id = d.id) AS device_count,
              (SELECT count(*)::int FROM patch_device_status s WHERE s.deployment_id = d.id AND s.status = 'succeeded') AS succeeded_count,
              (SELECT count(*)::int FROM patch_device_status s WHERE s.deployment_id = d.id AND s.status = 'failed') AS failed_count
         FROM patch_deployments d
         ${whereSql}
        ORDER BY d.created_at DESC
        LIMIT 200`,
      params,
    )
    return rows
  })
}

export async function getDeployment(
  pool: DbPool,
  tenantId: string,
  id: string,
): Promise<{ deployment: Record<string, unknown>; rings: Record<string, unknown>[] }> {
  return withTenant(pool, tenantId, async (client) => {
    const deployment = await getDeploymentRow(client, id)
    const { rows } = await client.query(
      `SELECT ring_index, status, count(*)::int AS n
         FROM patch_device_status
        WHERE deployment_id = $1
        GROUP BY ring_index, status
        ORDER BY ring_index, status`,
      [id],
    )
    return { deployment, rings: rows }
  })
}

async function transition(
  pool: DbPool,
  tenantId: string,
  id: string,
  from: PatchStatus,
  to: PatchStatus,
  extraSets: { col: string; value: unknown }[] = [],
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = await getDeploymentRow(client, id)
    if (existing.status !== from) throw AppError.badRequest(`Deployment must be in ${from} state`, 'invalid_status')
    const sets = [`status = '${to}'`, ...extraSets.map((e) => `${e.col} = $${extraSets.indexOf(e) + 1}`)]
    const params = extraSets.map((e) => e.value)
    params.push(id)
    const { rows } = await client.query(
      `UPDATE patch_deployments SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length} RETURNING *`,
      params,
    )
    return rows[0]
  })
}

export function submitDeployment(pool: DbPool, tenantId: string, id: string): Promise<Record<string, unknown>> {
  return transition(pool, tenantId, id, 'draft', 'pending_approval')
}

export function approveDeployment(pool: DbPool, tenantId: string, id: string, approverId: string): Promise<Record<string, unknown>> {
  return transition(pool, tenantId, id, 'pending_approval', 'approved', [{ col: 'approved_by', value: approverId }])
}

export function rejectDeployment(pool: DbPool, tenantId: string, id: string, approverId: string): Promise<Record<string, unknown>> {
  return transition(pool, tenantId, id, 'pending_approval', 'rejected', [{ col: 'approved_by', value: approverId }])
}

export async function startDeployment(pool: DbPool, tenantId: string, id: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = await getDeploymentRow(client, id)
    if (existing.status !== 'approved') throw AppError.badRequest('Deployment must be approved before rollout', 'invalid_status')

    const scopeType = existing.scope_type as string
    const scopeId = existing.scope_id as string | null
    const targetRes =
      scopeType === 'device_group'
        ? await client.query('SELECT id FROM devices WHERE group_id = $1', [scopeId])
        : await client.query('SELECT id FROM devices')

    const rings = existing.rings as PatchRing[]
    for (const device of targetRes.rows) {
      const ring = ringForDevice(device.id as string, rings)
      await client.query(
        `INSERT INTO patch_device_status (tenant_id, deployment_id, device_id, ring_index, status)
         VALUES ($1, $2, $3, $4, 'pending')
         ON CONFLICT (deployment_id, device_id) DO NOTHING`,
        [tenantId, id, device.id, ring],
      )
    }

    const { rows } = await client.query(
      `UPDATE patch_deployments SET status = 'rolling_out', started_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0]
  })
}

export function rollbackDeployment(pool: DbPool, tenantId: string, id: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = await getDeploymentRow(client, id)
    if (existing.status !== 'rolling_out' && existing.status !== 'paused' && existing.status !== 'completed') {
      throw AppError.badRequest('Deployment cannot be rolled back from its current state', 'invalid_status')
    }
    await client.query(
      `UPDATE patch_device_status SET status = 'rolled_back', updated_at = now() WHERE deployment_id = $1 AND status NOT IN ('succeeded', 'failed')`,
      [id],
    )
    const { rows } = await client.query(
      `UPDATE patch_deployments SET status = 'rolled_back', completed_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [id],
    )
    return rows[0]
  })
}

export async function reportDeviceStatus(
  pool: DbPool,
  tenantId: string,
  deploymentId: string,
  deviceId: string,
  status: DevicePatchStatus,
  detail: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE patch_device_status SET status = $4, detail = $5, updated_at = now()
        WHERE deployment_id = $1 AND device_id = $2 AND tenant_id = $3
        RETURNING *`,
      [deploymentId, deviceId, tenantId, status, detail.slice(0, 1000)],
    )
    if (!rows[0]) throw AppError.notFound('Device is not targeted by this deployment')
    return rows[0]
  })
}

export async function pendingForDevice(
  pool: DbPool,
  tenantId: string,
  deviceId: string,
): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT d.id, d.name, d.version, d.artifact_url, d.sha256, d.signature, d.channel,
              s.ring_index, s.status AS device_status
         FROM patch_deployments d
         JOIN patch_device_status s ON s.deployment_id = d.id
        WHERE s.device_id = $1 AND d.status = 'rolling_out' AND s.status IN ('pending', 'offered')
        ORDER BY s.ring_index, d.created_at`,
      [deviceId],
    )
    return rows
  })
}
