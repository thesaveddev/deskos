import { api } from './api.js'

export interface Service {
  id: string
  name: string
  description: string
  category_id: string | null
  category_name?: string | null
  sla_policy_id: string | null
  approval_required: boolean
  enabled: boolean
  form_fields: Record<string, unknown>[]
  created_at: string
  updated_at: string
}

export interface Approval {
  id: string
  ticket_id: string
  number: number
  subject: string
  type: string
  status: 'pending' | 'approved' | 'rejected'
  note: string
  requested_by_name: string | null
  created_at: string
  decided_at: string | null
}

export function listServices(params: { enabled?: boolean } = {}): Promise<{ services: Service[] }> {
  const query = new URLSearchParams()
  if (params.enabled !== undefined) query.set('enabled', String(params.enabled))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/services${suffix}`)
}

export function createService(body: {
  name: string
  description?: string
  categoryId?: string
  slaPolicyId?: string
  approvalRequired?: boolean
  enabled?: boolean
  formFields?: Record<string, unknown>[]
}): Promise<{ service: Service }> {
  return api('/services', { method: 'POST', body })
}

export function updateService(id: string, body: Partial<{
  name: string
  description: string
  categoryId: string | null
  slaPolicyId: string | null
  approvalRequired: boolean
  enabled: boolean
  formFields: Record<string, unknown>[]
}>): Promise<{ service: Service }> {
  return api(`/services/${id}`, { method: 'PATCH', body })
}

export function deleteService(id: string): Promise<{ ok: boolean }> {
  return api(`/services/${id}`, { method: 'DELETE' })
}

export function listMyApprovals(): Promise<{ approvals: Approval[] }> {
  return api('/approvals/mine')
}

export function listTicketApprovals(ticketId: string): Promise<{ approvals: Approval[] }> {
  return api(`/tickets/${ticketId}/approvals`)
}

export function decideApproval(ticketId: string, approvalId: string, decision: 'approved' | 'rejected', note?: string): Promise<{ approval: Approval }> {
  return api(`/tickets/${ticketId}/approvals/${approvalId}/decide`, { method: 'POST', body: { decision, note } })
}
