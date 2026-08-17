import { api } from './api.js'

export type ScriptApprovalStatus = 'draft' | 'pending' | 'approved' | 'rejected'
export type ScriptPrivilegeLevel = 'user' | 'elevated'

export interface Script {
  id: string
  name: string
  category: string
  os: string[]
  version: number
  approval_status: ScriptApprovalStatus
  body: string
  args_schema: Record<string, unknown>[]
  privilege_level: ScriptPrivilegeLevel
  author_name?: string | null
  approver_name?: string | null
  approved_at: string | null
  created_at: string
  updated_at: string
}

export interface ScriptRun {
  id: string
  script_id: string
  script_name?: string
  device_id: string | null
  actor_name?: string | null
  args: Record<string, unknown>
  exit_code: number | null
  output_ref: string | null
  started_at: string
  ended_at: string | null
}

export function listScripts(params: { category?: string; status?: ScriptApprovalStatus; q?: string } = {}): Promise<{ scripts: Script[] }> {
  const query = new URLSearchParams()
  if (params.category) query.set('category', params.category)
  if (params.status) query.set('status', params.status)
  if (params.q) query.set('q', params.q)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/scripts${suffix}`)
}

export function createScript(body: {
  name: string
  category?: string
  os?: string[]
  body?: string
  argsSchema?: Record<string, unknown>[]
  privilegeLevel?: ScriptPrivilegeLevel
}): Promise<{ script: Script }> {
  return api('/scripts', { method: 'POST', body })
}

export function updateScript(id: string, body: Partial<{
  name: string
  category: string
  os: string[]
  body: string
  argsSchema: Record<string, unknown>[]
  privilegeLevel: ScriptPrivilegeLevel
}>): Promise<{ script: Script }> {
  return api(`/scripts/${id}`, { method: 'PATCH', body })
}

export function submitScript(id: string): Promise<{ script: Script }> {
  return api(`/scripts/${id}/submit`, { method: 'POST', body: {} })
}

export function approveScript(id: string): Promise<{ script: Script }> {
  return api(`/scripts/${id}/approve`, { method: 'POST', body: {} })
}

export function rejectScript(id: string): Promise<{ script: Script }> {
  return api(`/scripts/${id}/reject`, { method: 'POST', body: {} })
}

export function deleteScript(id: string): Promise<{ ok: boolean }> {
  return api(`/scripts/${id}`, { method: 'DELETE' })
}

export function runScript(id: string, body: { deviceId?: string; args?: Record<string, unknown> }): Promise<{ run: ScriptRun }> {
  return api(`/scripts/${id}/run`, { method: 'POST', body })
}

export function listScriptRuns(id: string): Promise<{ runs: ScriptRun[] }> {
  return api(`/scripts/${id}/runs`)
}
