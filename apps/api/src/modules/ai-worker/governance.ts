import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

// ---------------------------------------------------------------------------
// Activity logging
// ---------------------------------------------------------------------------

export interface ActivityLogEntry {
  actor_type: string
  actor_id?: string
  action: string
  tool_name?: string
  resource_type?: string
  resource_id?: string
  data_accessed?: Record<string, unknown>
  input_tokens?: number
  output_tokens?: number
  duration_ms?: number
  success?: boolean
  error_message?: string
  ip_address?: string
}

/** Record an AI activity event for the governance dashboard. */
export async function logAiActivity(
  pool: DbPool,
  tenantId: string,
  entry: ActivityLogEntry,
): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ai_activity_log
        (tenant_id, actor_type, actor_id, action, tool_name, resource_type, resource_id,
         data_accessed, input_tokens, output_tokens, duration_ms, success, error_message, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
      [
        tenantId,
        entry.actor_type,
        entry.actor_id ?? null,
        entry.action,
        entry.tool_name ?? null,
        entry.resource_type ?? null,
        entry.resource_id ?? null,
        JSON.stringify(entry.data_accessed ?? {}),
        entry.input_tokens ?? 0,
        entry.output_tokens ?? 0,
        entry.duration_ms ?? 0,
        entry.success ?? true,
        entry.error_message ?? null,
        entry.ip_address ?? null,
      ],
    )
  })
}

export interface ActivityLogFilters {
  action?: string
  actor_type?: string
  tool_name?: string
  limit?: number
  cursor?: string
  days?: number
}

/** Query the AI activity log with filters. */
export async function listAiActivity(
  pool: DbPool,
  tenantId: string,
  filters: ActivityLogFilters = {},
): Promise<{ entries: Record<string, unknown>[]; total: number; nextCursor: string | null }> {
  return withTenant(pool, tenantId, async (client) => {
    const conditions: string[] = ['tenant_id = $1']
    const params: unknown[] = [tenantId]
    if (filters.action) { params.push(filters.action); conditions.push(`action = $${params.length}`) }
    if (filters.actor_type) { params.push(filters.actor_type); conditions.push(`actor_type = $${params.length}`) }
    if (filters.tool_name) { params.push(filters.tool_name); conditions.push(`tool_name = $${params.length}`) }
    if (filters.days) { params.push(filters.days); conditions.push(`created_at > now() - ($${params.length} || ' days')::interval`) }
    if (filters.cursor) { params.push(filters.cursor); conditions.push(`created_at < $${params.length}::timestamptz`) }
    const whereSql = conditions.join(' AND ')
    const limit = Math.min(Math.max(1, filters.limit ?? 50), 200)
    const { rows } = await client.query(
      `SELECT * FROM ai_activity_log WHERE ${whereSql} ORDER BY created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit + 1],
    )
    const hasMore = rows.length > limit
    const entries = hasMore ? rows.slice(0, limit) : rows
    const nextCursor = hasMore && entries.length > 0 ? String(entries[entries.length - 1].created_at) : null
    const countResult = await client.query(
      `SELECT count(*)::int AS total FROM ai_activity_log WHERE ${whereSql}`,
      params.slice(0, params.length - (filters.cursor ? 1 : 0)),
    )
    return { entries, total: countResult.rows[0]?.total ?? 0, nextCursor }
  })
}

/** Get activity summary stats for the governance dashboard. */
export async function getActivitySummary(
  pool: DbPool,
  tenantId: string,
  days = 30,
): Promise<{
  totalActions: number
  successfulActions: number
  failedActions: number
  toolUsage: Array<{ tool: string; count: number; success_rate: number }>
  actorBreakdown: Array<{ actor_type: string; count: number }>
  tokenUsage: { input: number; output: number }
  avgDurationMs: number
}> {
  return withTenant(pool, tenantId, async (client) => {
    const totals = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE success = true)::int AS successful,
              count(*) FILTER (WHERE success = false)::int AS failed,
              COALESCE(sum(input_tokens), 0)::int AS input_tokens,
              COALESCE(sum(output_tokens), 0)::int AS output_tokens,
              COALESCE(avg(duration_ms), 0)::int AS avg_duration
       FROM ai_activity_log
       WHERE created_at > now() - ($1 || ' days')::interval`,
      [days],
    )
    const tools = await client.query(
      `SELECT tool_name AS tool, count(*)::int AS count,
              round(count(*) FILTER (WHERE success = true)::numeric / GREATEST(count(*), 1) * 100, 1)::float AS success_rate
       FROM ai_activity_log
       WHERE created_at > now() - ($1 || ' days')::interval AND tool_name IS NOT NULL
       GROUP BY tool_name ORDER BY count DESC LIMIT 20`,
      [days],
    )
    const actors = await client.query(
      `SELECT actor_type, count(*)::int AS count
       FROM ai_activity_log
       WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY actor_type ORDER BY count DESC`,
      [days],
    )
    return {
      totalActions: Number(totals.rows[0]?.total ?? 0),
      successfulActions: Number(totals.rows[0]?.successful ?? 0),
      failedActions: Number(totals.rows[0]?.failed ?? 0),
      toolUsage: tools.rows,
      actorBreakdown: actors.rows,
      tokenUsage: { input: Number(totals.rows[0]?.input_tokens ?? 0), output: Number(totals.rows[0]?.output_tokens ?? 0) },
      avgDurationMs: Number(totals.rows[0]?.avg_duration ?? 0),
    }
  })
}

// ---------------------------------------------------------------------------
// Tool permissions
// ---------------------------------------------------------------------------

export interface ToolPermission {
  id: string
  tenant_id: string
  tool_name: string
  enabled: boolean
  requires_approval: boolean
  max_uses_per_hour: number
  allowed_roles: string[]
  created_at: string
  updated_at: string
}

const DEFAULT_TOOL_PERMISSIONS: Array<{ tool_name: string; enabled: boolean; requires_approval: boolean; max_uses_per_hour: number }> = [
  { tool_name: 'ticket.get', enabled: true, requires_approval: false, max_uses_per_hour: 200 },
  { tool_name: 'device.inventory', enabled: true, requires_approval: false, max_uses_per_hour: 100 },
  { tool_name: 'device.run_script', enabled: true, requires_approval: true, max_uses_per_hour: 20 },
  { tool_name: 'device.restart', enabled: true, requires_approval: true, max_uses_per_hour: 10 },
  { tool_name: 'ticket.note', enabled: true, requires_approval: false, max_uses_per_hour: 50 },
  { tool_name: 'ticket.resolve', enabled: true, requires_approval: false, max_uses_per_hour: 30 },
  { tool_name: 'ticket.handoff', enabled: true, requires_approval: false, max_uses_per_hour: 30 },
]

/** List tool permissions for a tenant. */
export async function listToolPermissions(pool: DbPool, tenantId: string): Promise<ToolPermission[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM ai_tool_permissions WHERE tenant_id = $1 ORDER BY tool_name', [tenantId])
    return rows
  })
}

/** Ensure default tool permissions exist for a tenant. */
export async function ensureToolPermissions(pool: DbPool, tenantId: string): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    for (const tp of DEFAULT_TOOL_PERMISSIONS) {
      await client.query(
        `INSERT INTO ai_tool_permissions (tenant_id, tool_name, enabled, requires_approval, max_uses_per_hour)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, tool_name) DO NOTHING`,
        [tenantId, tp.tool_name, tp.enabled, tp.requires_approval, tp.max_uses_per_hour],
      )
    }
  })
}

/** Update a tool permission. */
export async function updateToolPermission(
  pool: DbPool,
  tenantId: string,
  toolName: string,
  patch: { enabled?: boolean; requires_approval?: boolean; max_uses_per_hour?: number; allowed_roles?: string[] },
): Promise<ToolPermission> {
  return withTenant(pool, tenantId, async (client) => {
    const updates: string[] = []
    const params: unknown[] = [tenantId, toolName]
    if (patch.enabled !== undefined) { params.push(patch.enabled); updates.push(`enabled = $${params.length}`) }
    if (patch.requires_approval !== undefined) { params.push(patch.requires_approval); updates.push(`requires_approval = $${params.length}`) }
    if (patch.max_uses_per_hour !== undefined) { params.push(patch.max_uses_per_hour); updates.push(`max_uses_per_hour = $${params.length}`) }
    if (patch.allowed_roles !== undefined) { params.push(patch.allowed_roles); updates.push(`allowed_roles = $${params.length}`) }
    if (updates.length === 0) {
      const { rows } = await client.query('SELECT * FROM ai_tool_permissions WHERE tenant_id = $1 AND tool_name = $2', [tenantId, toolName])
      if (!rows[0]) throw AppError.notFound('Tool permission not found')
      return rows[0]
    }
    updates.push('updated_at = now()')
    const { rows } = await client.query(
      `UPDATE ai_tool_permissions SET ${updates.join(', ')} WHERE tenant_id = $1 AND tool_name = $2 RETURNING *`,
      params,
    )
    if (!rows[0]) throw AppError.notFound('Tool permission not found')
    return rows[0]
  })
}

/** Check if a tool is allowed for the given role. */
export async function isToolAllowed(
  pool: DbPool,
  tenantId: string,
  toolName: string,
  role?: string,
): Promise<{ allowed: boolean; requiresApproval: boolean }> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT enabled, requires_approval, allowed_roles FROM ai_tool_permissions WHERE tenant_id = $1 AND tool_name = $2',
      [tenantId, toolName],
    )
    if (!rows[0]) return { allowed: true, requiresApproval: false }
    if (!rows[0].enabled) return { allowed: false, requiresApproval: false }
    const allowedRoles: string[] = rows[0].allowed_roles ?? []
    if (allowedRoles.length > 0 && role && !allowedRoles.includes(role)) return { allowed: false, requiresApproval: false }
    return { allowed: true, requiresApproval: rows[0].requires_approval }
  })
}

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

/** Estimated cost per 1K tokens by provider (input/output). */
const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  openai_compatible: { input: 0.00015, output: 0.0006 },
  azure_openai: { input: 0.00015, output: 0.0006 },
  ollama: { input: 0, output: 0 },
  vllm: { input: 0, output: 0 },
}

/** Estimate cost in USD for a given token count and provider. */
export function estimateCost(provider: string, inputTokens: number, outputTokens: number): number {
  const rates = COST_PER_1K_TOKENS[provider] ?? COST_PER_1K_TOKENS.openai_compatible
  return (inputTokens / 1000) * rates.input + (outputTokens / 1000) * rates.output
}

/** Update cost tracking on a worker run. */
export async function updateRunCosts(
  pool: DbPool,
  tenantId: string,
  runId: string,
  inputTokens: number,
  outputTokens: number,
  provider: string,
): Promise<void> {
  const cost = estimateCost(provider, inputTokens, outputTokens)
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `UPDATE ai_worker_runs
       SET input_tokens = input_tokens + $3,
           output_tokens = output_tokens + $4,
           estimated_cost_usd = estimated_cost_usd + $5,
           updated_at = now()
       WHERE id = $1 AND tenant_id = $2`,
      [runId, tenantId, inputTokens, outputTokens, cost],
    )
  })
}

/** Get cost summary for a tenant. */
export async function getCostSummary(
  pool: DbPool,
  tenantId: string,
  days = 30,
): Promise<{
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalRuns: number
  avgCostPerRun: number
  costByDay: Array<{ day: string; cost: number; runs: number }>
}> {
  return withTenant(pool, tenantId, async (client) => {
    const totals = await client.query(
      `SELECT COALESCE(sum(estimated_cost_usd), 0)::numeric AS total_cost,
              COALESCE(sum(input_tokens), 0)::int AS input_tokens,
              COALESCE(sum(output_tokens), 0)::int AS output_tokens,
              count(*)::int AS total_runs
       FROM ai_worker_runs
       WHERE created_at > now() - ($1 || ' days')::interval`,
      [days],
    )
    const daily = await client.query(
      `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
              COALESCE(sum(estimated_cost_usd), 0)::numeric AS cost,
              count(*)::int AS runs
       FROM ai_worker_runs
       WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY 1 ORDER BY 1`,
      [days],
    )
    const totalCost = Number(totals.rows[0]?.total_cost ?? 0)
    const totalRuns = Number(totals.rows[0]?.total_runs ?? 0)
    return {
      totalCostUsd: totalCost,
      totalInputTokens: Number(totals.rows[0]?.input_tokens ?? 0),
      totalOutputTokens: Number(totals.rows[0]?.output_tokens ?? 0),
      totalRuns,
      avgCostPerRun: totalRuns > 0 ? totalCost / totalRuns : 0,
      costByDay: daily.rows.map((r) => ({ day: r.day, cost: Number(r.cost), runs: Number(r.runs) })),
    }
  })
}

// ---------------------------------------------------------------------------
// Usage alerts
// ---------------------------------------------------------------------------

export interface UsageAlert {
  id: string
  tenant_id: string
  alert_type: string
  threshold_value: number
  current_value: number
  notified: boolean
  notified_at: string | null
  created_at: string
}

/** Check and fire usage alerts for a tenant. */
export async function checkUsageAlerts(
  pool: DbPool,
  tenantId: string,
): Promise<UsageAlert[]> {
  return withTenant(pool, tenantId, async (client) => {
    // Get current usage
    const usage = await client.query(
      `SELECT request_count, token_count FROM ai_usage_periods
       WHERE tenant_id = $1 AND period_start = date_trunc('month', now())::date`,
      [tenantId],
    )
    const requests = Number(usage.rows[0]?.request_count ?? 0)
    const tokens = Number(usage.rows[0]?.token_count ?? 0)

    // Get alerts that haven't been notified
    const alerts = await client.query(
      `SELECT * FROM ai_usage_alerts WHERE tenant_id = $1 AND notified = false`,
      [tenantId],
    )

    const fired: UsageAlert[] = []
    for (const alert of alerts.rows) {
      let currentValue = 0
      if (alert.alert_type === 'request_threshold') currentValue = requests
      else if (alert.alert_type === 'token_threshold') currentValue = tokens
      else continue

      if (currentValue >= alert.threshold_value) {
        await client.query(
          `UPDATE ai_usage_alerts SET current_value = $3, notified = true, notified_at = now() WHERE id = $1 AND tenant_id = $2`,
          [alert.id, tenantId, currentValue],
        )
        fired.push({ ...alert, current_value: currentValue, notified: true, notified_at: new Date().toISOString() })
      } else {
        await client.query(
          `UPDATE ai_usage_alerts SET current_value = $3 WHERE id = $1 AND tenant_id = $2`,
          [alert.id, tenantId, currentValue],
        )
      }
    }
    return fired
  })
}

/** Create a usage alert threshold. */
export async function createUsageAlert(
  pool: DbPool,
  tenantId: string,
  alertType: string,
  thresholdValue: number,
): Promise<UsageAlert> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ai_usage_alerts (tenant_id, alert_type, threshold_value)
       VALUES ($1, $2, $3) RETURNING *`,
      [tenantId, alertType, thresholdValue],
    )
    return rows[0]
  })
}

/** List usage alerts for a tenant. */
export async function listUsageAlerts(pool: DbPool, tenantId: string): Promise<UsageAlert[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM ai_usage_alerts WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    )
    return rows
  })
}

/** Delete a usage alert. */
export async function deleteUsageAlert(pool: DbPool, tenantId: string, alertId: string): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const { rowCount } = await client.query('DELETE FROM ai_usage_alerts WHERE id = $1 AND tenant_id = $2', [alertId, tenantId])
    if (!rowCount) throw AppError.notFound('Alert not found')
  })
}
