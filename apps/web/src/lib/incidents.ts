import { api } from './api.js'

export type IncidentSeverity = 'sev1' | 'sev2' | 'sev3' | 'sev4' | 'sev5'
export type IncidentStatus = 'open' | 'investigating' | 'identified' | 'mitigated' | 'resolved' | 'closed'

export interface MajorIncident {
  id: string
  ticket_id: string
  severity: IncidentSeverity
  status: IncidentStatus
  commander_id: string | null
  commander_name: string | null
  declared_by: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
  number: number
  subject: string
  priority: string
  ticket_status: string
}

export interface IncidentLink {
  id: string
  link_type: string
  target_number: number
  target_subject: string
  target_status: string
  target_priority: string
}

export function listIncidents(filters: { status?: IncidentStatus; severity?: IncidentSeverity } = {}): Promise<{ incidents: MajorIncident[] }> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.severity) params.set('severity', filters.severity)
  const qs = params.toString()
  return api(`/incidents${qs ? `?${qs}` : ''}`)
}

export function getIncident(id: string): Promise<{ incident: MajorIncident; links: IncidentLink[] }> {
  return api(`/incidents/${id}`)
}

export function declareIncident(body: {
  subject: string
  description?: string
  severity?: IncidentSeverity
  commanderId?: string
}): Promise<{ incident: MajorIncident; ticketId: string }> {
  return api('/incidents', { method: 'POST', body })
}

export function updateIncident(id: string, body: {
  severity?: IncidentSeverity
  status?: IncidentStatus
  commanderId?: string | null
}): Promise<{ incident: MajorIncident }> {
  return api(`/incidents/${id}`, { method: 'PATCH', body })
}

export function bridgeIncident(id: string, targetTicketId: string): Promise<{ linkId: string; duplicate: boolean }> {
  return api(`/incidents/${id}/bridge`, { method: 'POST', body: { targetTicketId } })
}
