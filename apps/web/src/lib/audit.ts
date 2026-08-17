import { api } from './api.js'

export interface AuditEntry {
  id: string
  actor_type: string
  actor_id: string | null
  actor_name: string | null
  action: string
  object_type: string | null
  object_id: string | null
  ip: string | null
  payload: Record<string, unknown>
  entry_hash: string
  created_at: string
}

export interface AuditFilters {
  action?: string
  actorId?: string
  objectType?: string
  from?: string
  to?: string
  before?: string
  limit?: number
}

export function listAudit(filters: AuditFilters = {}): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.actorId) params.set('actorId', filters.actorId)
  if (filters.objectType) params.set('objectType', filters.objectType)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.before) params.set('before', filters.before)
  if (filters.limit) params.set('limit', String(filters.limit))
  const qs = params.toString()
  return api(`/audit${qs ? `?${qs}` : ''}`)
}

export function verifyAudit(): Promise<{ ok: boolean; total: number; brokenAtId?: number }> {
  return api('/audit/verify')
}

export function auditExportUrl(filters: { action?: string; from?: string; to?: string } = {}): string {
  const params = new URLSearchParams()
  if (filters.action) params.set('action', filters.action)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  const qs = params.toString()
  return `/api/v1/audit/export.csv${qs ? `?${qs}` : ''}`
}

export interface ComplianceReport {
  audit: { total: number; last24h: number; integrityOk: boolean; brokenAtId?: number }
  jit: { total: number; active: number; approved: number; revoked: number }
  recordings: { sessions: number; video: number; metadata: number }
}

export function getComplianceReport(): Promise<ComplianceReport> {
  return api('/reports/compliance')
}

export interface AnalyticsReport {
  sessions: {
    total: number
    live: number
    avg_duration_min: number
    byType: Array<{ type: string; n: number }>
    byState: Array<{ state: string; n: number }>
    perDay: Array<{ day: string; n: number }>
  }
  workload: Array<{ id: string; name: string; open: number; resolved: number; avg_resolution_min: number }>
  sla: { resolved: number; breached: number; complianceRate: number }
}

export function getAnalyticsReport(): Promise<AnalyticsReport> {
  return api('/reports/analytics')
}
