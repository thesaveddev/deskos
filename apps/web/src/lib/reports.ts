import { api } from './api.js'

export interface OverviewReport {
  totals: { total: number; open: number; resolved: number; new_count: number; escalated: number; breached: number }
  resolution: { n: number; avg_minutes: number; median_minutes: number; p95_minutes: number }
  firstResponse: { n: number; avg_minutes: number; median_minutes: number }
  sla: { resolved: number; response_breached: number; resolution_breached: number; complianceRate: number }
  byStatus: Array<{ status: string; n: number }>
  byPriority: Array<{ priority: string; n: number }>
  byType: Array<{ type: string; n: number }>
  bySource: Array<{ source: string; n: number }>
  byCategory: Array<{ category: string; n: number }>
  byTeam: Array<{ team: string; n: number }>
  hourly: Array<{ hour: number; n: number }>
  daily: Array<{ day: string; n: number }>
  byAssignee: Array<{
    id: string; name: string; total: number; open: number; resolved: number
    avg_resolution_min: number; avg_response_min: number
  }>
  sessions: { total: number; live: number; avg_duration_min: number }
  auditTotal: number
  aiWorkers: {
    total: number
    resolved: number
    escalated: number
    resolutionRate: number
    timeSavedMinutes: number
    avgActualMinutes: number
  }
  aiWorkerTimeSeries: Array<{ day: string; total: number; resolved: number; handoff: number; failed: number }>
  updateHealth: {
    healthChecks: number
    offersChecked: number
    successfulUpdates: number
    failedUpdates: number
    lastCheck: string | null
  }
}

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
  csat: {
    rated: number
    responseRate: number
    average: number
    satisfied: number
    satisfactionRate: number
    byRating: Array<{ rating: number; n: number }>
    perTechnician: Array<{ id: string; name: string; rated: number; average: number }>
  }
}

export interface ComplianceReport {
  audit: { total: number; last24h: number; integrityOk: boolean; brokenAtId?: number }
  jit: { total: number; active: number; approved: number; revoked: number }
  recordings: { sessions: number; video: number; metadata: number }
}

export function getOverviewReport(params?: { from?: string; to?: string }): Promise<OverviewReport> {
  const qs = new URLSearchParams()
  if (params?.from) qs.set('from', params.from)
  if (params?.to) qs.set('to', params.to)
  const q = qs.toString()
  return api(`/reports/overview${q ? `?${q}` : ''}`)
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

export interface AiWorkerTimeSeries {
  day: string; total: number; resolved: number; handoff: number; failed: number
}

export function getAiWorkerTimeSeries(days = 30): Promise<{ timeseries: AiWorkerTimeSeries[] }> {
  return api(`/ai-worker/timeseries?days=${days}`)
}

export interface AiWorkerRun {
  id: string; tenant_id: string; ticket_id: string | null; device_id: string | null
  worker: string; status: string; summary: string; steps: unknown[]
  outcome: Record<string, unknown>; started_at: string | null; finished_at: string | null
  created_at: string; updated_at: string
  ticket_number?: number; ticket_subject?: string; device_name?: string
}

export interface AiWorkerRunList {
  runs: AiWorkerRun[]; nextCursor: string | null; total: number
}

export function getAiWorkerRuns(params?: { status?: string; limit?: number; cursor?: string; ticketId?: string }): Promise<AiWorkerRunList> {
  const qs = new URLSearchParams()
  if (params?.status) qs.set('status', params.status)
  if (params?.limit) qs.set('limit', String(params.limit))
  if (params?.cursor) qs.set('cursor', params.cursor)
  if (params?.ticketId) qs.set('ticketId', params.ticketId)
  const q = qs.toString()
  return api(`/ai-worker/runs${q ? `?${q}` : ''}`)
}

export function formatMinutes(min: number): string {
  if (!min || min < 1) return '—'
  if (min < 60) return `${Math.round(min)}m`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m ? `${h}h ${m}m` : `${h}h`
}

/* ═══════════════════════════════════════════════════════════════
   Export Utilities
   ═══════════════════════════════════════════════════════════════ */

export function exportCSV(headers: string[], rows: any[][], filename: string) {
  const csv = [headers.join(','), ...rows.map(r => r.map(v => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }).join(','))].join('\n')
  downloadBlob(csv, `${filename}.csv`, 'text/csv')
}

export function exportJSON(data: any, filename: string) {
  downloadBlob(JSON.stringify(data, null, 2), `${filename}.json`, 'application/json')
}

export function exportHTML(title: string, tableHTML: string, filename: string) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; color: #1a1d23; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #555b65; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; background: #f0f2f5; border-bottom: 2px solid #d0d4da; font-weight: 600; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e5e9; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  @media print { body { padding: 0; } }
</style></head><body><h1>${title}</h1>
<div class="subtitle">Generated by ReyDesk · ${new Date().toLocaleDateString()}</div>
${tableHTML}</body></html>`
  downloadBlob(html, `${filename}.html`, 'text/html')
}

export function printReport(title: string, tableHTML: string) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; padding: 24px; color: #1a1d23; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .subtitle { color: #555b65; font-size: 13px; margin-bottom: 20px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 6px 10px; background: #f0f2f5; border-bottom: 2px solid #d0d4da; font-weight: 600; }
  td { padding: 6px 10px; border-bottom: 1px solid #e2e5e9; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  @media print { body { padding: 0; } }
</style></head><body><h1>${title}</h1>
<div class="subtitle">Generated by ReyDesk · ${new Date().toLocaleDateString()}</div>
${tableHTML}</body></html>`
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close(); w.print() }
}

function downloadBlob(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
