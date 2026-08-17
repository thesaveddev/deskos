import { api } from './api.js'

export type PatchStatus = 'draft' | 'pending_approval' | 'approved' | 'rolling_out' | 'paused' | 'completed' | 'rejected' | 'rolled_back'

export interface PatchRing {
  name: string
  percent: number
}

export interface PatchDeployment {
  id: string
  name: string
  version: string
  channel: string
  status: PatchStatus
  scope_type: string
  scope_id: string | null
  rings: PatchRing[]
  created_at: string
  started_at: string | null
  completed_at: string | null
  device_count: number
  succeeded_count: number
  failed_count: number
}

export function listPatches(status?: PatchStatus): Promise<{ patches: PatchDeployment[] }> {
  const qs = status ? `?status=${status}` : ''
  return api(`/patches${qs}`)
}

export function getPatch(id: string): Promise<{ deployment: PatchDeployment; rings: Array<{ ring_index: number; status: string; n: number }> }> {
  return api(`/patches/${id}`)
}

export function createPatch(body: {
  name: string
  version: string
  description?: string
  artifactUrl: string
  sha256: string
  signature?: string
  channel?: 'stable' | 'beta'
  scopeType?: 'tenant' | 'device_group'
  scopeId?: string
  rings?: PatchRing[]
}): Promise<{ patch: PatchDeployment }> {
  return api('/patches', { method: 'POST', body })
}

export function submitPatch(id: string): Promise<{ patch: PatchDeployment }> {
  return api(`/patches/${id}/submit`, { method: 'POST' })
}

export function approvePatch(id: string): Promise<{ patch: PatchDeployment }> {
  return api(`/patches/${id}/approve`, { method: 'POST' })
}

export function rejectPatch(id: string): Promise<{ patch: PatchDeployment }> {
  return api(`/patches/${id}/reject`, { method: 'POST' })
}

export function startPatch(id: string): Promise<{ patch: PatchDeployment }> {
  return api(`/patches/${id}/start`, { method: 'POST' })
}

export function rollbackPatch(id: string): Promise<{ patch: PatchDeployment }> {
  return api(`/patches/${id}/rollback`, { method: 'POST' })
}
