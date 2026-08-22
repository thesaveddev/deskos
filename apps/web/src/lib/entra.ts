import { api } from './api.js'

export interface EntraConnection {
  id: string
  name: string
  azureTenantId: string
  clientId: string
  hasSecret: boolean
  clientSecretMasked: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface EntraConnectionInput {
  name: string
  azureTenantId: string
  clientId: string
  clientSecret: string
  enabled?: boolean
}

export interface SyncRun {
  id: string
  connection_id: string | null
  connection_name?: string | null
  status: 'started' | 'ok' | 'partial' | 'error'
  fetched: number
  created: number
  updated: number
  error: string | null
  started_at: string
  finished_at: string | null
}

export interface EntraAction {
  id: string
  action: string
  target_upn: string
  status: 'requested' | 'ok' | 'error'
  detail: string | null
  actor_name?: string | null
  created_at: string
}

export interface Contact {
  id: string
  name: string
  email: string
  department: string | null
  account_status: string
  staff_id?: string | null
  job_title?: string | null
  ext_identity: Record<string, unknown>
}

export function listEntraConnections(): Promise<{ connections: EntraConnection[] }> {
  return api('/entra/connections')
}

export function createEntraConnection(body: EntraConnectionInput): Promise<{ id: string }> {
  return api('/entra/connections', { method: 'POST', body })
}

export function updateEntraConnection(id: string, body: Partial<EntraConnectionInput>): Promise<{ ok: boolean }> {
  return api(`/entra/connections/${id}`, { method: 'PATCH', body })
}

export function deleteEntraConnection(id: string): Promise<{ ok: boolean }> {
  return api(`/entra/connections/${id}`, { method: 'DELETE' })
}

export function testEntraConnection(id: string): Promise<{ ok: boolean; users?: number }> {
  return api(`/entra/connections/${id}/test`, { method: 'POST', body: {} })
}

export interface DiagnosticStep {
  name: string
  label: string
  status: 'pending' | 'running' | 'ok' | 'warn' | 'error'
  detail?: string
  durationMs?: number
}

export function diagnoseEntraConnection(id: string): Promise<{ steps: DiagnosticStep[] }> {
  return api(`/entra/connections/${id}/diagnose`, { method: 'POST', body: {} })
}

export function syncEntraDirectory(id: string): Promise<{ fetched: number; created: number; updated: number }> {
  return api(`/entra/connections/${id}/sync`, { method: 'POST', body: {} })
}

export function syncEntraDevices(id: string): Promise<{ fetched: number; created: number; updated: number }> {
  return api(`/entra/connections/${id}/sync-devices`, { method: 'POST', body: {} })
}

export function runEntraAction(id: string, body: { action: 'resetPassword' | 'requireMfa'; upn: string; newPassword?: string }): Promise<{ id: string; status: string; detail: string }> {
  return api(`/entra/connections/${id}/actions`, { method: 'POST', body })
}

export function listSyncRuns(): Promise<{ runs: SyncRun[] }> {
  return api('/entra/sync-runs')
}

export function listEntraActions(): Promise<{ actions: EntraAction[] }> {
  return api('/entra/actions')
}

export function listContacts(): Promise<{ contacts: Contact[] }> {
  return api('/entra/contacts')
}
