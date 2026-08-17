import { api } from './api.js'

export type RemediationStatus = 'proposed' | 'approved' | 'denied' | 'executed' | 'failed' | 'skipped'
export type RemediationTool = 'restart_device' | 'collect_inventory' | 'run_script' | 'add_ticket_note' | 'set_ticket_priority'
export type RemediationSourceType = 'device_alert' | 'posture_alert' | 'dex' | 'ticket'

export interface Remediation {
  id: string
  source_type: RemediationSourceType
  source_id: string | null
  device_id: string | null
  device_name: string | null
  tool: RemediationTool
  tool_args: Record<string, unknown>
  rationale: string
  status: RemediationStatus
  proposed_by: string
  approved_by: string | null
  approver_name: string | null
  executed_at: string | null
  result: Record<string, unknown>
  created_at: string
}

export function listRemediations(status?: RemediationStatus): Promise<{ remediations: Remediation[] }> {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  const qs = params.toString()
  return api(`/ai-agent/remediations${qs ? `?${qs}` : ''}`)
}

export function proposeRemediation(signal: {
  sourceType: RemediationSourceType
  sourceId?: string
  deviceId?: string
  kind?: string
  checkPath?: string
  ticketId?: string
}): Promise<{ remediation: Remediation }> {
  return api('/ai-agent/remediations', {
    method: 'POST',
    body: {
      sourceType: signal.sourceType,
      sourceId: signal.sourceId,
      deviceId: signal.deviceId,
      kind: signal.kind,
      checkPath: signal.checkPath,
      ticketId: signal.ticketId,
    },
  })
}

export function approveRemediation(id: string): Promise<{ remediation: Remediation }> {
  return api(`/ai-agent/remediations/${id}/approve`, { method: 'POST' })
}

export function denyRemediation(id: string): Promise<{ remediation: Remediation }> {
  return api(`/ai-agent/remediations/${id}/deny`, { method: 'POST' })
}
