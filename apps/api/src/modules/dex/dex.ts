import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface DexInput {
  cpu: number
  mem: number
  disk: number
  postureRatio: number
  online: boolean
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)))
}

export function computeScore(input: DexInput): { score: number; components: Record<string, number> } {
  const health = clamp(100 - (input.cpu * 0.3 + input.mem * 0.3 + input.disk * 0.4))
  const posture = clamp(input.postureRatio * 100)
  const availability = input.online ? 100 : 40
  const score = clamp(health * 0.4 + posture * 0.4 + availability * 0.2)
  return { score, components: { health, posture, availability } }
}

function getPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), obj)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface PolicyRow {
  id: string
  group_id: string | null
  posture_checks: Array<{ check: string; expected: unknown }>
}

/**
 * Compute and store the DEX score for a device and evaluate its endpoint
 * policies against the reported security posture (raising/resolving posture
 * alerts). Runs inside a tenant-scoped transaction.
 */
export async function evaluateDevice(client: DbClient, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  const device = (await client.query('SELECT last_seen_at, group_id FROM devices WHERE id = $1', [deviceId])).rows[0]
  if (!device) return { score: null }

  const metrics = (await client.query(
    `SELECT avg(cpu_pct)::float AS cpu, avg(mem_pct)::float AS mem, avg(disk_pct)::float AS disk
       FROM (SELECT cpu_pct, mem_pct, disk_pct FROM device_metrics WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 10) m`,
    [deviceId],
  )).rows[0]

  const inv = (await client.query('SELECT security_posture FROM device_inventory WHERE device_id = $1', [deviceId])).rows[0]
  const posture = (inv?.security_posture ?? {}) as Record<string, unknown>

  const policies = (await client.query(
    `SELECT id, group_id, posture_checks FROM endpoint_policies
      WHERE enabled = true AND (group_id IS NULL OR group_id = $1)`,
    [device.group_id],
  )).rows as PolicyRow[]

  let passing = 0
  let total = 0
  for (const policy of policies) {
    for (const check of policy.posture_checks ?? []) {
      if (!check?.check) continue
      total += 1
      const actual = getPath(posture, check.check)
      const ok = deepEqual(actual, check.expected)
      if (ok) {
        passing += 1
        await client.query(
          `UPDATE posture_alerts SET status = 'resolved', resolved_at = now()
            WHERE device_id = $1 AND check_path = $2 AND status = 'open'`,
          [deviceId, check.check],
        )
      } else {
        await client.query(
          `INSERT INTO posture_alerts (tenant_id, device_id, policy_id, check_path, expected, actual)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
           ON CONFLICT (device_id, check_path) WHERE status = 'open'
           DO UPDATE SET expected = EXCLUDED.expected, actual = EXCLUDED.actual, created_at = now()`,
          [tenantId, deviceId, policy.id, check.check, JSON.stringify(check.expected), JSON.stringify(actual ?? null)],
        )
      }
    }
  }

  const cpu = metrics?.cpu ?? 0
  const mem = metrics?.mem ?? 0
  const disk = metrics?.disk ?? 0
  const online = Boolean(device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 5 * 60_000)
  const postureRatio = total === 0 ? 1 : passing / total
  const { score, components } = computeScore({ cpu, mem, disk, postureRatio, online })

  await client.query(
    `INSERT INTO device_dex_scores (tenant_id, device_id, score, components)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (device_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, computed_at = now(), updated_at = now()`,
    [tenantId, deviceId, score, JSON.stringify(components)],
  )

  return { score, components, posture: { total, passing, failing: total - passing } }
}

export async function recomputeDevice(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, (client) => evaluateDevice(client, tenantId, deviceId))
}

export async function getDeviceDex(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const score = (await client.query('SELECT * FROM device_dex_scores WHERE device_id = $1', [deviceId])).rows[0]
    const alerts = (await client.query(
      `SELECT id, policy_id, check_path, expected, actual, created_at FROM posture_alerts
        WHERE device_id = $1 AND status = 'open' ORDER BY created_at`,
      [deviceId],
    )).rows
    return { score: score ?? null, postureAlerts: alerts }
  })
}

export async function fleetDex(pool: DbPool, tenantId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const summary = (await client.query(
      `SELECT count(*)::int AS devices, COALESCE(round(avg(score)), 0)::int AS avg_score,
              count(*) FILTER (WHERE score >= 80)::int AS healthy,
              count(*) FILTER (WHERE score < 60)::int AS poor
         FROM device_dex_scores`,
    )).rows[0]
    const openPosture = (await client.query(`SELECT count(*)::int AS n FROM posture_alerts WHERE status = 'open'`)).rows[0]
    return { ...summary, openPostureAlerts: openPosture.n }
  })
}
