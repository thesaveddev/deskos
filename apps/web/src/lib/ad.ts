import { api } from './api.js'

export interface AdConnection {
  id: string
  name: string
  host: string
  port: number
  useSsl: boolean
  baseDn: string
  bindDn: string
  hasSecret: boolean
  bindPasswordMasked: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface AdConnectionInput {
  name: string
  host: string
  port?: number
  useSsl?: boolean
  baseDn: string
  bindDn: string
  bindPassword: string
  enabled?: boolean
}

export type AdActionType = 'resetPassword' | 'unlockAccount' | 'enableAccount' | 'disableAccount'

export interface AdAction {
  id: string
  action: AdActionType
  target_upn: string
  status: string
  detail: string | null
  actor_name: string | null
  connection_name: string | null
  created_at: string
}

export interface SyncRun {
  id: string
  connection_name: string | null
  status: string
  fetched: number
  created: number
  updated: number
  error: string | null
  started_at: string
}

export interface Contact {
  id: string
  name: string
  email: string
  department: string | null
  account_status: string
  staff_id?: string | null
}

export function listAdConnections(): Promise<{ connections: AdConnection[] }> {
  return api('/ad/connections')
}

export function createAdConnection(body: AdConnectionInput): Promise<{ id: string }> {
  return api('/ad/connections', { method: 'POST', body })
}

export function updateAdConnection(id: string, body: Partial<AdConnectionInput>): Promise<{ ok: boolean }> {
  return api(`/ad/connections/${id}`, { method: 'PATCH', body })
}

export function deleteAdConnection(id: string): Promise<{ ok: boolean }> {
  return api(`/ad/connections/${id}`, { method: 'DELETE' })
}

export function testAdConnection(id: string): Promise<{ ok: boolean; users?: number }> {
  return api(`/ad/connections/${id}/test`, { method: 'POST', body: {} })
}

export function syncAdDirectory(id: string): Promise<{ fetched: number; created: number; updated: number }> {
  return api(`/ad/connections/${id}/sync`, { method: 'POST', body: {} })
}

export function syncAdDevices(id: string): Promise<{ fetched: number; created: number; updated: number }> {
  return api(`/ad/connections/${id}/sync-devices`, { method: 'POST', body: {} })
}

export function runAdAction(id: string, body: { action: AdActionType; upn: string; newPassword?: string }): Promise<{ id: string; status: string; detail: string }> {
  return api(`/ad/connections/${id}/actions`, { method: 'POST', body })
}

export function listAdSyncRuns(): Promise<{ runs: SyncRun[] }> {
  return api('/ad/sync-runs')
}

export function listAdActions(): Promise<{ actions: AdAction[] }> {
  return api('/ad/actions')
}

export function listAdContacts(): Promise<{ contacts: Contact[] }> {
  return api('/ad/contacts')
}
