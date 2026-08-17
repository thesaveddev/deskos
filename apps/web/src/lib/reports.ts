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

export function getTicketReport(): Promise<TicketReport> {
  return api('/reports/tickets')
}

export function formatMinutes(min: number): string {
  if (!min || min < 1) return '—'
  if (min < 60) return `${Math.round(min)}m`
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return m ? `${h}h ${m}m` : `${h}h`
}