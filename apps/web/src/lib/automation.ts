import { api } from './api.js'

export type AutomationTrigger = 'ticket.created' | 'ticket.updated' | 'device.offline' | 'device.low_disk'
export type ConditionOp = 'eq' | 'neq' | 'contains' | 'in'

export interface AutomationCondition {
  field: string
  op: ConditionOp
  value?: unknown
}

export interface AutomationConditions {
  all?: AutomationCondition[]
  any?: AutomationCondition[]
}

export type AutomationAction =
  | { type: 'set_priority'; priority: string }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'assign_team'; team_id: string }
  | { type: 'assign_user'; user_id: string }
  | { type: 'notify'; role?: string; user_id?: string; body?: string }
  | { type: 'add_note'; body: string }
  | { type: 'webhook'; url: string }

export interface Automation {
  id: string
  name: string
  trigger: AutomationTrigger
  conditions: AutomationConditions
  actions: AutomationAction[]
  enabled: boolean
  last_run_at: string | null
  run_count: number
  created_at: string
  updated_at: string
}

export interface AutomationRun {
  id: string | number
  trigger: string
  subject_type: string
  subject_id: string
  status: 'ok' | 'skipped' | 'error' | 'deferred'
  log: Record<string, unknown>
  created_at: string
}

export function listAutomations(): Promise<{ automations: Automation[] }> {
  return api('/automations')
}

export function createAutomation(body: {
  name: string
  trigger: AutomationTrigger
  conditions?: AutomationConditions
  actions: AutomationAction[]
  enabled?: boolean
}): Promise<{ automation: Automation }> {
  return api('/automations', { method: 'POST', body })
}

export function updateAutomation(id: string, body: {
  name?: string
  conditions?: AutomationConditions
  actions?: AutomationAction[]
  enabled?: boolean
}): Promise<{ automation: Automation }> {
  return api(`/automations/${id}`, { method: 'PATCH', body })
}

export function toggleAutomation(id: string, enabled: boolean): Promise<{ automation: { id: string; enabled: boolean; updated_at: string } }> {
  return api(`/automations/${id}/toggle`, { method: 'POST', body: { enabled } })
}

export function deleteAutomation(id: string): Promise<{ ok: boolean }> {
  return api(`/automations/${id}`, { method: 'DELETE' })
}

export function listAutomationRuns(id: string): Promise<{ runs: AutomationRun[] }> {
  return api(`/automations/${id}/runs`)
}
