import { api } from './api.js'

export type GrantStatus = 'pending' | 'approved' | 'denied' | 'revoked' | 'expired' | 'active'
export type GrantScope = 'tenant' | 'device_group' | 'device'
export type GrantPermission = 'remote.elevated' | 'remote.control' | 'remote.attended' | 'remote.unattended' | 'remote.inspection' | 'script.execute'

export interface Grant {
  id: string
  permission: GrantPermission
  scope_type: GrantScope
  scope_id: string | null
  subject_id: string
  grantee_name: string | null
  requested_by_name: string | null
  granted_by: string | null
  reason: string
  status: GrantStatus
  effective_status: GrantStatus
  expires_at: string
  checked_out_at: string | null
  checked_in_at: string | null
  created_at: string
}

export function listGrants(filters: { status?: GrantStatus; mine?: boolean } = {}): Promise<{ grants: Grant[] }> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.mine) params.set('mine', '1')
  const qs = params.toString()
  return api(`/grants${qs ? `?${qs}` : ''}`)
}

export function requestGrant(body: {
  granteeId?: string
  permission: GrantPermission
  scopeType: GrantScope
  scopeId?: string
  reason: string
  expiresAt: string
}): Promise<{ grant: Grant }> {
  return api('/grants', { method: 'POST', body })
}

export function approveGrant(id: string): Promise<{ grant: Grant }> {
  return api(`/grants/${id}/approve`, { method: 'POST' })
}

export function denyGrant(id: string): Promise<{ grant: Grant }> {
  return api(`/grants/${id}/deny`, { method: 'POST' })
}

export function revokeGrant(id: string): Promise<{ grant: Grant }> {
  return api(`/grants/${id}/revoke`, { method: 'POST' })
}

export function checkoutGrant(id: string): Promise<{ grant: Grant }> {
  return api(`/grants/${id}/checkout`, { method: 'POST' })
}

export function checkinGrant(id: string): Promise<{ grant: Grant }> {
  return api(`/grants/${id}/checkin`, { method: 'POST' })
}
