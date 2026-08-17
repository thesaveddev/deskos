import { api } from './api.js'

export interface PortalTicket {
  id: string
  number: number
  type: string
  status: string
  priority: string
  subject: string
  due_response_at: string | null
  due_resolution_at: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export interface PortalThread {
  id: string
  kind: string
  body: string
  author_name?: string | null
  created_at: string
}

export function portalTickets(): Promise<{ tickets: PortalTicket[] }> {
  return api('/portal/tickets')
}

export function portalTicket(number: number): Promise<{ ticket: PortalTicket; threads: PortalThread[] }> {
  return api(`/portal/tickets/${number}`)
}

export function createPortalTicket(body: { subject: string; description?: string }): Promise<{ ticket: PortalTicket }> {
  return api('/portal/tickets', { method: 'POST', body })
}

export function replyPortalTicket(number: number, body: string): Promise<{ thread: PortalThread }> {
  return api(`/portal/tickets/${number}/reply`, { method: 'POST', body: { body } })
}

export function resolvePortalTicket(number: number): Promise<{ ticket: PortalTicket }> {
  return api(`/portal/tickets/${number}/resolve`, { method: 'POST' })
}
