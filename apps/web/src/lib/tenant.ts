import { api } from './api.js'

export interface Tenant {
  id: string
  name: string
  slug: string
  region: string
  settings: Record<string, unknown>
  created_at: string
}

export interface TenantResponse {
  tenant: Tenant
  membership: { orgRole: string; membershipId: string }
}

export function getTenant(): Promise<TenantResponse> {
  return api<TenantResponse>('/tenant')
}

export function updateTenant(patch: { name?: string; slug?: string; region?: string }): Promise<{
  ok: boolean
  tenant: Tenant
}> {
  return api('/tenant', { method: 'PATCH', body: patch })
}
