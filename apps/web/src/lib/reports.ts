import { api } from './api.js'

export interface TicketReport {
  totals: { total: number; open: number; resolved: number; breached: number }
  byStatus: Array<{ status: string; n: number }>
  byPriority: Array<{ priority: string; n: number }>
  resolution: { n: number; avg_minutes: number }
  firstResponse: { n: number; avg_minutes: number }
  byAssignee: Array<{ id: string; name: string; open_tickets: number }>
  createdDaily: Array<{ day: string; n: number }>
}

export interface AnalyticsReport {
  sessions: {
    total: number; live: number; avg_duration_min: number
    byType: Array<{ type: string; n: number }>
    byState: Array<{ state: string; n: number }>
    perDay: Array<{ day: string; n: number }>
  }
  workload: Array<{
    id: string; name: string; open: number; resolved: number; avg_resolution_min: number
  }>
  sla: { resolved: number; breached: number; complianceRate: number }
}

export interface ComplianceReport {
  audit: { total: number; last24h: number; integrityOk: boolean; brokenAtId?: number }
  jit: { total: number; active: number; approved: number; revoked: number }
  recordings: { sessions: number; video: number; metadata: number }
}

export function getTicketReport(): Promise<TicketReport> {
  return api('/reports/tickets')
}

export function getAnalyticsReport(): Promise<AnalyticsReport> {
  return api('/reports/analytics')
}

export function getComplianceReport(): Promise<ComplianceReport> {
  return api('/reports/compliance')
}

export function formatMinutes(min: number): string {
  if (!min || min < 1) return '—'
  if (min < 60) return `${Math.round(min)}m`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m ? `${h}h ${m}m` : `${h}h`
}
