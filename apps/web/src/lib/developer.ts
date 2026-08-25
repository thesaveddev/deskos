import { api } from './api.js'

export interface ApiScope {
  scope: string
  permission: string
  description: string
}

export interface ApiAllowlistEntry {
  id: string
  cidr: string
  label: string
  enabled: boolean
  created_at: string
}

export interface ApiSecuritySettings {
  ip_allowlist_enabled: boolean
  allowlist: ApiAllowlistEntry[]
}

export interface ApiUsage {
  days: number
  total: number
  errors: number
  byDay: Array<{ day: string; requests: number; errors: number }>
  byClient: Array<{ client_id: string | null; requests: number }>
  byPath: Array<{ path: string; requests: number }>
}

export interface DeveloperOverview {
  baseUrl: string
  specUrl: string
  auth: {
    tokenUrl: string
    authorizeUrl: string
    grantTypes: string[]
  }
  endpoints: Array<{ method: string; path: string; scope: string; description: string }>
  scopes: ApiScope[]
}

export function getDeveloperOverview(): Promise<DeveloperOverview> {
  return api('/developer/overview')
}

export function getApiSecurity(): Promise<ApiSecuritySettings> {
  return api('/oauth/security')
}

export function updateApiSecurity(enabled: boolean): Promise<ApiSecuritySettings> {
  return api('/oauth/security', { method: 'PATCH', body: { enabled } })
}

export function addApiAllowlist(cidr: string, label: string): Promise<{ entry: ApiAllowlistEntry }> {
  return api('/oauth/security/allowlist', { method: 'POST', body: { cidr, label } })
}

export function removeApiAllowlist(id: string): Promise<{ ok: boolean }> {
  return api(`/oauth/security/allowlist/${id}`, { method: 'DELETE' })
}

export function getApiUsage(days = 30): Promise<ApiUsage> {
  return api(`/oauth/security/usage?days=${days}`)
}
