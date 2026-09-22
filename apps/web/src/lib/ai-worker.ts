import { api } from './api.js'

export type WorkerRunStatus = 'queued' | 'running' | 'waiting_approval' | 'waiting_action' | 'resolved' | 'handoff' | 'failed' | 'cancelled'
export type WorkerStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'dispatched' | 'succeeded' | 'failed' | 'skipped' | 'denied'
export type WorkerRiskTier = 'read' | 'low' | 'high'

export interface WorkerStep {
  id: string
  phase: 'diagnose' | 'plan' | 'act' | 'verify'
  tool: string
  toolArgs: Record<string, unknown>
  risk: WorkerRiskTier
  rationale: string
  status: WorkerStepStatus
  result?: Record<string, unknown> | null
  error?: string | null
  startedAt?: string
  finishedAt?: string
  approvedBy?: string | null
  actionId?: string | null
}

export interface WorkerRun {
  id: string
  tenant_id: string
  ticket_id: string | null
  device_id: string | null
  worker: string
  status: WorkerRunStatus
  summary: string
  context: Record<string, unknown>
  steps: WorkerStep[]
  outcome: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  ticket_number?: number | null
  ticket_subject?: string | null
  device_name?: string | null
}

export function listWorkerRuns(status?: WorkerRunStatus, ticketId?: string): Promise<{ runs: WorkerRun[] }> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (ticketId) params.set('ticketId', ticketId)
  const qs = params.toString()
  return api(`/ai-worker/runs${qs ? `?${qs}` : ''}`)
}

export function getWorkerRun(id: string): Promise<{ run: WorkerRun }> {
  return api(`/ai-worker/runs/${id}`)
}

export function createWorkerRun(ticketId: string): Promise<{ run: WorkerRun }> {
  return api('/ai-worker/runs', { method: 'POST', body: { ticketId } })
}

export function approveWorkerRun(id: string): Promise<{ run: WorkerRun }> {
  return api(`/ai-worker/runs/${id}/approve`, { method: 'POST' })
}

export function denyWorkerRun(id: string): Promise<{ run: WorkerRun }> {
  return api(`/ai-worker/runs/${id}/deny`, { method: 'POST' })
}

export function cancelWorkerRun(id: string): Promise<{ run: WorkerRun }> {
  return api(`/ai-worker/runs/${id}/cancel`, { method: 'POST' })
}

export interface IdentityCredential {
  id: string
  playbook_id: string
  name: string
  token_prefix: string
  status: 'active' | 'revoked' | 'expired'
  expires_at: string
  last_used_at: string | null
  usage_count: number
  created_at: string
  revoked_at: string | null
}

export interface Playbook {
  id: string
  name: string
  description: string
  category: string
  trigger_keywords: string[]
  system_prompt: string
  max_steps: number
  auto_approve_low_risk: boolean
  enabled: boolean
  usage_count: number
  success_rate: number
  machine_identity: string
  allowed_tools: string[]
  access_reviewed_at: string | null
  access_reviewed_by: string | null
  identity_status: 'active' | 'revoked'
  identity_version: number
  identity_rotated_at: string | null
  identity_revoked_at: string | null
  identity_revoked_reason: string | null
}

export function createPlaybook(body: {
  name: string
  description: string
  category: string
  trigger_keywords: string[]
  system_prompt: string
  max_steps: number
  auto_approve_low_risk: boolean
}): Promise<{ playbook: Playbook }> {
  return api('/ai-playbooks', { method: 'POST', body })
}

export function getPlaybook(id: string): Promise<{ playbook: Playbook }> {
  return api(`/ai-playbooks/${id}`)
}

export function listPlaybooks(): Promise<{ playbooks: Playbook[] }> {
  return api('/ai-playbooks')
}

export function updatePlaybook(id: string, body: Partial<Omit<Playbook, 'id' | 'tenant_id' | 'usage_count' | 'success_rate'>>): Promise<{ playbook: Playbook }> {
  return api(`/ai-playbooks/${id}`, { method: 'PATCH', body })
}

export function deletePlaybook(id: string): Promise<void> {
  return api(`/ai-playbooks/${id}`, { method: 'DELETE' })
}

export function reviewPlaybookAccess(id: string): Promise<{ playbook: Playbook }> {
  return api(`/ai-playbooks/${id}/access-review`, { method: 'POST', body: {} })
}

export function rotatePlaybookIdentity(id: string): Promise<{ playbook: Playbook }> {
  return api(`/ai-playbooks/${id}/identity/rotate`, { method: 'POST', body: {} })
}

export function revokePlaybookIdentity(id: string, reason: string): Promise<{ playbook: Playbook }> {
  return api(`/ai-playbooks/${id}/identity/revoke`, { method: 'POST', body: { reason } })
}

export function listIdentityCredentials(id: string): Promise<{ credentials: IdentityCredential[] }> {
  return api(`/ai-playbooks/${id}/identity/credentials`)
}

export function issueIdentityCredential(id: string, body: { name: string; expiresInDays: number }): Promise<{ credential: IdentityCredential; token: string }> {
  return api(`/ai-playbooks/${id}/identity/credentials`, { method: 'POST', body })
}

export function revokeIdentityCredential(id: string, credentialId: string): Promise<{ credential: IdentityCredential }> {
  return api(`/ai-playbooks/${id}/identity/credentials/${credentialId}`, { method: 'DELETE' })
}

export function seedPlaybooks(): Promise<{ seeded: number; message: string }> {
  return api('/ai-playbooks/seed', { method: 'POST', body: {} })
}

export const WORKER_RUN_LABELS: Record<WorkerRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Needs approval',
  waiting_action: 'Waiting on device',
  resolved: 'Resolved',
  handoff: 'Handed to technician',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const WORKER_STEP_LABELS: Record<WorkerStepStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  awaiting_approval: 'Needs approval',
  dispatched: 'Dispatched to device',
  succeeded: 'Succeeded',
  failed: 'Failed',
  skipped: 'Skipped',
  denied: 'Denied',
}