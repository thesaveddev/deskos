import { api } from './api.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface ActivityLogEntry {
  id: string
  tenant_id: string
  actor_type: string
  actor_id: string | null
  action: string
  tool_name: string | null
  resource_type: string | null
  resource_id: string | null
  data_accessed: Record<string, unknown> | null
  input_tokens: number
  output_tokens: number
  duration_ms: number
  success: boolean
  error_message: string | null
  ip_address: string | null
  created_at: string
}

export interface ActivitySummary {
  totalActions: number
  successfulActions: number
  failedActions: number
  toolUsage: Array<{ tool: string; count: number; success_rate: number }>
  actorBreakdown: Array<{ actor_type: string; count: number }>
  tokenUsage: { input: number; output: number }
  avgDurationMs: number
}

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

export interface CostSummary {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalRuns: number
  avgCostPerRun: number
  costByDay: Array<{ day: string; cost: number; runs: number }>
}

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

// ── API functions ──────────────────────────────────────────────────────

export function getGovernanceSummary(days?: number): Promise<{ summary: ActivitySummary }> {
  return api(`/ai-governance/summary${days ? `?days=${days}` : ''}`)
}

export function getGovernanceActivity(filters?: {
  action?: string
  actor_type?: string
  tool_name?: string
  limit?: number
  days?: number
}): Promise<{ entries: ActivityLogEntry[]; total: number; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (filters?.action) params.set('action', filters.action)
  if (filters?.actor_type) params.set('actor_type', filters.actor_type)
  if (filters?.tool_name) params.set('tool_name', filters.tool_name)
  if (filters?.limit) params.set('limit', String(filters.limit))
  if (filters?.days) params.set('days', String(filters.days))
  const qs = params.toString()
  return api(`/ai-governance/activity${qs ? `?${qs}` : ''}`)
}

export function getToolPermissions(): Promise<{ permissions: ToolPermission[] }> {
  return api('/ai-governance/tools')
}

export function updateToolPermission(
  toolName: string,
  body: { enabled?: boolean; requires_approval?: boolean; max_uses_per_hour?: number; allowed_roles?: string[] },
): Promise<{ permission: ToolPermission }> {
  return api(`/ai-governance/tools/${encodeURIComponent(toolName)}`, { method: 'PATCH', body })
}

export function getCostSummary(days?: number): Promise<{ costs: CostSummary }> {
  return api(`/ai-governance/costs${days ? `?days=${days}` : ''}`)
}

export function listUsageAlerts(): Promise<{ alerts: UsageAlert[] }> {
  return api('/ai-governance/alerts')
}

export function createUsageAlert(alertType: string, thresholdValue: number): Promise<{ alert: UsageAlert }> {
  return api('/ai-governance/alerts', { method: 'POST', body: { alert_type: alertType, threshold_value: thresholdValue } })
}

export function deleteUsageAlert(id: string): Promise<void> {
  return api(`/ai-governance/alerts/${id}`, { method: 'DELETE' })
}

export function checkUsageAlerts(): Promise<{ fired: UsageAlert[] }> {
  return api('/ai-governance/alerts/check', { method: 'POST' })
}
