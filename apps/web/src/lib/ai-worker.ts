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

export function listWorkerRuns(status?: WorkerRunStatus): Promise<{ runs: WorkerRun[] }> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
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