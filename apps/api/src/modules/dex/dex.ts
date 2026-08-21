import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { createAutomationTicket, firstOwner } from '../devices/alerts.js'

export interface DexInput {
  cpu: number
  mem: number
  disk: number
  postureRatio: number
  online: boolean
  networkLatencyMs?: number | null
  packetLossPct?: number | null
  batteryHealthPct?: number | null
  crashRate?: number
  launchDurationMs?: number | null
  surveyRating?: number | null
  deviceType?: string | null
}

export interface DexComponents {
  performance: number
  availability: number
  security: number
  user_impact: number
  // Compatibility aliases used by the original DEX cards and API clients.
  health: number
  posture: number
  online: number
  application_reliability: number
  network_quality: number
}

const DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  laptop: { performance: 0.3, availability: 0.2, security: 0.2, user_impact: 0.3 },
  workstation: { performance: 0.35, availability: 0.2, security: 0.25, user_impact: 0.2 },
  server: { performance: 0.25, availability: 0.4, security: 0.3, user_impact: 0.05 },
  network_device: { performance: 0.25, availability: 0.45, security: 0.25, user_impact: 0.05 },
  mobile: { performance: 0.3, availability: 0.25, security: 0.2, user_impact: 0.25 },
  other: { performance: 0.35, availability: 0.25, security: 0.25, user_impact: 0.15 },
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(v) ? v : 0)))
}

function weightsFor(deviceType: string | null | undefined, custom?: Record<string, unknown>): Record<string, number> {
  const base = DEFAULT_WEIGHTS[deviceType ?? 'other'] ?? DEFAULT_WEIGHTS.other
  const candidate = custom ?? base
  const values = ['performance', 'availability', 'security', 'user_impact'].map((key) => Math.max(0, Number(candidate[key] ?? base[key])))
  const total = values.reduce((sum, value) => sum + value, 0) || 1
  return Object.fromEntries(['performance', 'availability', 'security', 'user_impact'].map((key, index) => [key, values[index] / total]))
}

export function computeScore(input: DexInput): { score: number; components: DexComponents } {
  const health = clamp(100 - (input.cpu * 0.28 + input.mem * 0.28 + input.disk * 0.24))
  const latencyPenalty = input.networkLatencyMs == null ? 0 : Math.min(20, input.networkLatencyMs / 10)
  const packetLossPenalty = input.packetLossPct == null ? 0 : Math.min(25, input.packetLossPct * 2)
  const networkQuality = clamp(100 - latencyPenalty - packetLossPenalty)
  const applicationReliability = clamp(100 - Math.min(100, (input.crashRate ?? 0) * 100))
  const launchPenalty = input.launchDurationMs == null ? 0 : Math.min(25, Math.max(0, input.launchDurationMs - 1500) / 200)
  const performance = clamp(health * 0.72 + networkQuality * 0.18 + applicationReliability * 0.1 - launchPenalty)
  const availability = input.online ? 100 : 0
  const posture = clamp(input.postureRatio * 100)
  const security = posture
  const userImpact = input.surveyRating == null
    ? clamp(applicationReliability * 0.7 + (input.online ? 30 : 0))
    : clamp(input.surveyRating * 20)
  const weights = weightsFor(input.deviceType)
  const score = clamp(
    performance * weights.performance +
    availability * weights.availability +
    security * weights.security +
    userImpact * weights.user_impact,
  )
  return {
    score,
    components: {
      performance,
      availability,
      security,
      user_impact: userImpact,
      health,
      posture,
      online: availability,
      application_reliability: applicationReliability,
      network_quality: networkQuality,
    },
  }
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

function recommendations(components: DexComponents, signals: Record<string, number | null>): Array<{ code: string; title: string; detail: string; priority: 'high' | 'medium' | 'low' }> {
  const result: Array<{ code: string; title: string; detail: string; priority: 'high' | 'medium' | 'low' }> = []
  if (components.availability < 70) result.push({ code: 'availability', title: 'Investigate endpoint availability', detail: 'The endpoint is missing heartbeats or has repeated service interruptions.', priority: 'high' })
  if (components.performance < 65) result.push({ code: 'performance', title: 'Review resource pressure', detail: 'CPU, memory, disk, or startup latency is materially affecting experience.', priority: 'high' })
  if ((signals.network_packet_loss_pct ?? 0) >= 3 || (signals.network_latency_ms ?? 0) >= 150) result.push({ code: 'network', title: 'Investigate network quality', detail: 'Latency or packet loss is high enough to affect interactive work.', priority: 'medium' })
  if ((signals.application_crash_rate ?? 0) >= 0.05) result.push({ code: 'application-crashes', title: 'Review application crashes', detail: 'One or more monitored applications are crashing more often than expected.', priority: 'high' })
  if (components.security < 80) result.push({ code: 'security', title: 'Resolve security posture findings', detail: 'One or more endpoint policy checks are failing.', priority: 'high' })
  if (components.user_impact < 65) result.push({ code: 'user-impact', title: 'Follow up with the affected user', detail: 'User feedback or application behavior indicates a poor experience.', priority: 'medium' })
  return result
}

/**
 * Compute and store four explainable experience scores for one device. Raw
 * telemetry and experience events are read independently; a bad scoring rule
 * cannot prevent the agent from reporting health.
 */
export async function evaluateDevice(client: DbClient, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  const device = (await client.query(
    `SELECT d.last_seen_at, d.group_id, d.device_type, da.user_id, da.department, da.location, da.team_id
       FROM devices d
       LEFT JOIN device_assignments da ON da.device_id = d.id AND da.ended_at IS NULL
      WHERE d.id = $1 AND d.tenant_id = $2`,
    [deviceId, tenantId],
  )).rows[0]
  if (!device) return { score: null }

  const metrics = (await client.query(
    `SELECT avg(cpu_pct)::float AS cpu, avg(mem_pct)::float AS mem, avg(disk_pct)::float AS disk,
            avg(network_latency_ms)::float AS network_latency_ms,
            avg(network_packet_loss_pct)::float AS packet_loss_pct,
            avg(battery_health_pct)::float AS battery_health_pct
       FROM (SELECT cpu_pct, mem_pct, disk_pct, network_latency_ms, network_packet_loss_pct, battery_health_pct
               FROM device_metrics WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 20) m`,
    [deviceId],
  )).rows[0]

  const eventStats = (await client.query(
    `SELECT count(*) FILTER (WHERE event_type = 'launch')::int AS launches,
            count(*) FILTER (WHERE event_type = 'crash')::int AS crashes,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE event_type IN ('launch', 'login') AND duration_ms IS NOT NULL) AS p95_startup_ms
       FROM dex_experience_events
      WHERE device_id = $1 AND occurred_at >= now() - interval '24 hours'`,
    [deviceId],
  )).rows[0]
  const survey = (await client.query(
    `SELECT avg(rating)::float AS rating FROM dex_user_surveys
      WHERE (device_id = $1 OR user_id = $2) AND created_at >= now() - interval '30 days'`,
    [deviceId, device.user_id ?? null],
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
      if (deepEqual(actual, check.expected)) {
        passing += 1
        await client.query(`UPDATE posture_alerts SET status = 'resolved', resolved_at = now() WHERE device_id = $1 AND check_path = $2 AND status = 'open'`, [deviceId, check.check])
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

  const cpu = Number(metrics?.cpu ?? 0)
  const mem = Number(metrics?.mem ?? 0)
  const disk = Number(metrics?.disk ?? 0)
  const crashRate = Number(eventStats?.launches ?? 0) === 0 ? 0 : Number(eventStats?.crashes ?? 0) / Number(eventStats.launches)
  const online = Boolean(device.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 5 * 60_000)
  const postureRatio = total === 0 ? 1 : passing / total
  const customPolicy = (await client.query(
    `SELECT weights FROM dex_scoring_policies
      WHERE enabled = true AND (device_type = $1 OR device_type IS NULL)
      ORDER BY (device_type IS NULL), created_at DESC LIMIT 1`,
    [device.device_type],
  )).rows[0]?.weights as Record<string, unknown> | undefined
  const base = computeScore({
    cpu, mem, disk, postureRatio, online,
    networkLatencyMs: metrics?.network_latency_ms == null ? null : Number(metrics.network_latency_ms),
    packetLossPct: metrics?.packet_loss_pct == null ? null : Number(metrics.packet_loss_pct),
    batteryHealthPct: metrics?.battery_health_pct == null ? null : Number(metrics.battery_health_pct),
    crashRate,
    launchDurationMs: eventStats?.p95_startup_ms == null ? null : Number(eventStats.p95_startup_ms),
    surveyRating: survey?.rating == null ? null : Number(survey.rating),
    deviceType: device.device_type,
  })
  const weights = weightsFor(device.device_type, customPolicy)
  const score = clamp(
    base.components.performance * weights.performance +
    base.components.availability * weights.availability +
    base.components.security * weights.security +
    base.components.user_impact * weights.user_impact,
  )
  const signals = {
    cpu_pct: cpu,
    memory_pct: mem,
    disk_pct: disk,
    network_latency_ms: metrics?.network_latency_ms == null ? null : Number(metrics.network_latency_ms),
    network_packet_loss_pct: metrics?.packet_loss_pct == null ? null : Number(metrics.packet_loss_pct),
    battery_health_pct: metrics?.battery_health_pct == null ? null : Number(metrics.battery_health_pct),
    application_crash_rate: crashRate,
    application_launch_count: Number(eventStats?.launches ?? 0),
    application_crash_count: Number(eventStats?.crashes ?? 0),
    boot_login_duration_ms: eventStats?.p95_startup_ms == null ? null : Number(eventStats.p95_startup_ms),
    survey_rating: survey?.rating == null ? null : Number(survey.rating),
  }
  const components = { ...base.components, ...{ score_weights: weights, signals } } as unknown as DexComponents
  const recs = recommendations(base.components, signals)

  await client.query(
    `INSERT INTO device_dex_scores (tenant_id, device_id, score, components)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (device_id) DO UPDATE SET score = EXCLUDED.score, components = EXCLUDED.components, computed_at = now(), updated_at = now()`,
    [tenantId, deviceId, score, JSON.stringify(components)],
  )

  const previous = (await client.query(`SELECT score, computed_at FROM device_dex_score_history WHERE device_id = $1 ORDER BY computed_at DESC LIMIT 1`, [deviceId])).rows[0]
  const ageMs = previous?.computed_at ? Date.now() - new Date(previous.computed_at).getTime() : Number.POSITIVE_INFINITY
  const scoreChanged = previous ? Math.abs(Number(previous.score) - score) >= 2 : true
  if (!previous || ageMs >= 5 * 60_000 || scoreChanged) {
    await client.query(`INSERT INTO device_dex_score_history (tenant_id, device_id, score, components) VALUES ($1, $2, $3, $4::jsonb)`, [tenantId, deviceId, score, JSON.stringify(components)])
  }

  // A ticket is deliberately created only after three consecutive sampled
  // scores remain poor. A single slow boot or transient Wi-Fi problem is not a
  // ticket; the evidence and recommendation remain visible in DEX.
  const lowScores = (await client.query(
    `SELECT score FROM device_dex_score_history WHERE device_id = $1 ORDER BY computed_at DESC LIMIT 3`,
    [deviceId],
  )).rows
  if (lowScores.length === 3 && lowScores.every((row) => Number(row.score) < 60)) {
    const existing = (await client.query(`SELECT id FROM device_alerts WHERE device_id = $1 AND kind = 'anomaly' AND resolved_at IS NULL LIMIT 1`, [deviceId])).rows[0]
    if (!existing) {
      const alert = (await client.query(
        `INSERT INTO device_alerts (tenant_id, device_id, kind, severity, message) VALUES ($1, $2, 'anomaly', 'warning', $3) RETURNING id`,
        [tenantId, deviceId, `Digital employee experience has remained below 60 for three consecutive samples.`],
      )).rows[0]
      const ownerId = await firstOwner(client, tenantId)
      if (ownerId) {
        const ticketId = await createAutomationTicket(client, tenantId, {
          subject: `Persistent experience degradation: ${deviceId}`,
          body: `DEX remained below 60 for three consecutive samples. Recommended actions: ${recs.map((item) => item.title).join('; ') || 'review endpoint telemetry'}.`,
          deviceId,
          requesterId: ownerId,
          priority: 'p3',
        })
        await client.query('UPDATE device_alerts SET ticket_id = $1 WHERE id = $2', [ticketId, alert.id])
      }
    }
  }

  return { score, components: base.components, posture: { total, passing, failing: total - passing }, recommendations: recs, assignment: { userId: device.user_id, department: device.department, teamId: device.team_id, location: device.location } }
}

export async function recomputeDevice(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, (client) => evaluateDevice(client, tenantId, deviceId))
}

export async function getDeviceDex(pool: DbPool, tenantId: string, deviceId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const score = (await client.query('SELECT * FROM device_dex_scores WHERE device_id = $1', [deviceId])).rows[0]
    const alerts = (await client.query(`SELECT id, policy_id, check_path, expected, actual, created_at FROM posture_alerts WHERE device_id = $1 AND status = 'open' ORDER BY created_at`, [deviceId])).rows
    const history = (await client.query(`SELECT id, score, components, computed_at FROM device_dex_score_history WHERE device_id = $1 ORDER BY computed_at DESC LIMIT 90`, [deviceId])).rows.reverse()
    const baseline = (await client.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY score)::float AS median,
              percentile_cont(0.9) WITHIN GROUP (ORDER BY score)::float AS p90,
              count(*)::int AS samples
         FROM device_dex_score_history WHERE device_id = $1 AND computed_at >= now() - interval '90 days'`,
      [deviceId],
    )).rows[0]
    const components = score?.components ?? {}
    const recs = score ? recommendations(components as DexComponents, (components.signals ?? {}) as Record<string, number | null>) : []
    return { score: score ?? null, history, baseline, postureAlerts: alerts, recommendations: recs }
  })
}

export async function fleetDex(pool: DbPool, tenantId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const summary = (await client.query(
      `SELECT count(*)::int AS devices, COALESCE(round(avg(score)), 0)::int AS avg_score,
              count(*) FILTER (WHERE score >= 80)::int AS healthy,
              count(*) FILTER (WHERE score < 60)::int AS poor,
              COALESCE(round(avg((components->>'performance')::numeric)), 0)::int AS performance_score,
              COALESCE(round(avg((components->>'availability')::numeric)), 0)::int AS availability_score,
              COALESCE(round(avg((components->>'security')::numeric)), 0)::int AS security_score,
              COALESCE(round(avg((components->>'user_impact')::numeric)), 0)::int AS user_impact_score
         FROM device_dex_scores`,
    )).rows[0]
    const openPosture = (await client.query(`SELECT count(*)::int AS n FROM posture_alerts WHERE status = 'open'`)).rows[0]
    const failingDevices = (await client.query(`SELECT count(DISTINCT device_id)::int AS n FROM posture_alerts WHERE status = 'open'`)).rows[0]
    const totalDevices = Number(summary.devices ?? 0)
    const failing = Number(failingDevices.n ?? 0)
    const compliant = Math.max(0, totalDevices - failing)
    const postureCompliance = { totalDevices, compliantDevices: compliant, failingDevices: failing, percentage: totalDevices === 0 ? 100 : Math.round((compliant / totalDevices) * 100) }
    const checks = (await client.query(`SELECT check_path, count(*)::int AS open_count FROM posture_alerts WHERE status = 'open' GROUP BY check_path ORDER BY open_count DESC, check_path ASC LIMIT 25`)).rows
    const comparisons = (await client.query(
      `SELECT COALESCE(NULLIF(da.department, ''), 'Unassigned') AS segment,
              count(*)::int AS devices, round(avg(s.score))::int AS score,
              round(avg((s.components->>'performance')::numeric))::int AS performance,
              round(avg((s.components->>'availability')::numeric))::int AS availability,
              round(avg((s.components->>'user_impact')::numeric))::int AS user_impact
         FROM device_dex_scores s JOIN devices d ON d.id = s.device_id
         LEFT JOIN device_assignments da ON da.device_id = d.id AND da.ended_at IS NULL
        GROUP BY 1 ORDER BY score ASC, segment ASC`,
    )).rows
    const trends = (await client.query(
      `SELECT date_trunc('day', computed_at)::date AS day, round(avg(score))::int AS score,
              round(avg((components->>'performance')::numeric))::int AS performance,
              round(avg((components->>'availability')::numeric))::int AS availability,
              round(avg((components->>'security')::numeric))::int AS security,
              round(avg((components->>'user_impact')::numeric))::int AS user_impact
         FROM device_dex_score_history
        WHERE computed_at >= now() - interval '90 days'
        GROUP BY 1 ORDER BY 1`,
    )).rows
    const affected = (await client.query(
      `SELECT d.id, d.name, d.device_type, s.score, s.components, da.department, da.location, u.name AS user_name, u.email AS user_email
         FROM device_dex_scores s JOIN devices d ON d.id = s.device_id
         LEFT JOIN device_assignments da ON da.device_id = d.id AND da.ended_at IS NULL
         LEFT JOIN users u ON u.id = da.user_id
        WHERE s.score < 70 ORDER BY s.score ASC, d.name ASC LIMIT 50`,
    )).rows
    const recommendationsList = affected.flatMap((row) => {
      const c = (row.components ?? {}) as DexComponents
      return recommendations(c, ((c as unknown as { signals?: Record<string, number | null> }).signals ?? {})).slice(0, 2).map((item) => ({ ...item, deviceId: row.id, deviceName: row.name, userName: row.user_name }))
    })
    return {
      ...summary,
      componentScores: { performance: Number(summary.performance_score), availability: Number(summary.availability_score), security: Number(summary.security_score), userImpact: Number(summary.user_impact_score) },
      openPostureAlerts: openPosture.n,
      postureCompliance,
      postureChecks: checks,
      comparisons,
      trends,
      affected,
      recommendations: recommendationsList.slice(0, 30),
    }
  })
}

export async function recordExperienceEvent(client: DbClient, tenantId: string, deviceId: string, input: { userId?: string | null; applicationName: string; eventType: string; durationMs?: number | null; successful?: boolean | null; metadata?: Record<string, unknown> }): Promise<void> {
  await client.query(
    `INSERT INTO dex_experience_events (tenant_id, device_id, user_id, application_name, event_type, duration_ms, successful, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [tenantId, deviceId, input.userId ?? null, input.applicationName, input.eventType, input.durationMs ?? null, input.successful ?? null, JSON.stringify(input.metadata ?? {})],
  )
}
