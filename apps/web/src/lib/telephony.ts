import { api } from './api.js'

export type CallDirection = 'inbound' | 'outbound' | 'internal'
export type CallStatus = 'ringing' | 'answered' | 'missed' | 'completed' | 'failed'

export interface CallLog {
  id: string
  direction: CallDirection
  from_number: string
  to_number: string
  status: CallStatus
  caller_name: string | null
  started_at: string
  duration_sec: number
  ticket_id: string | null
  ticket_number: number | null
  ticket_subject: string | null
  provider_call_id: string | null
  ext?: Record<string, unknown>
}

export interface TelephonyIntegration {
  id: string
  name: string
  provider: string
  enabled: boolean
  auto_match: boolean
  click_to_call_url: string | null
  has_provider_secret: boolean
  provider_config?: { accountSid?: string; fromNumber?: string; twimlUrl?: string; webhookUrl?: string }
  webhook_path: string
  created_at: string
  updated_at: string
}

export interface ListCallsFilters {
  ticketId?: string
  direction?: CallDirection
  status?: CallStatus
  q?: string
}

export function listTelephonyIntegrations(): Promise<{ integrations: TelephonyIntegration[] }> {
  return api('/telephony/integrations')
}

export function createTelephonyIntegration(body: { name: string; provider?: string; clickToCallUrl?: string; providerSecret?: string; providerConfig?: Record<string, unknown>; autoMatch?: boolean; enabled?: boolean }): Promise<{ integration: TelephonyIntegration; webhookToken: string }> {
  return api('/telephony/integrations', { method: 'POST', body })
}

export function deleteTelephonyIntegration(id: string): Promise<{ ok: true }> {
  return api(`/telephony/integrations/${id}`, { method: 'DELETE' })
}

export function listCalls(filters: ListCallsFilters = {}): Promise<{ calls: CallLog[] }> {
  const params = new URLSearchParams()
  if (filters.ticketId) params.set('ticketId', filters.ticketId)
  if (filters.direction) params.set('direction', filters.direction)
  if (filters.status) params.set('status', filters.status)
  if (filters.q) params.set('q', filters.q)
  const qs = params.toString()
  return api(`/telephony/calls${qs ? `?${qs}` : ''}`)
}

export function clickToCall(body: { toNumber: string; fromNumber?: string; ticketId?: string | null }): Promise<{ call: CallLog; dialUri: string }> {
  return api('/telephony/click-to-call', { method: 'POST', body })
}

export function matchCall(id: string): Promise<{ call: CallLog; match: { status: string; candidates: Array<{ id: string; number: number; subject: string }> } }> {
  return api(`/telephony/calls/${id}/match`, { method: 'POST', body: {} })
}

export function logCall(body: {
  direction: CallDirection
  fromNumber?: string
  toNumber?: string
  status?: CallStatus
  callerName?: string
  durationSec?: number
  ticketId?: string
}): Promise<{ call: CallLog }> {
  return api('/telephony/calls', { method: 'POST', body })
}

export function linkCall(id: string, ticketId: string | null): Promise<{ call: CallLog }> {
  return api(`/telephony/calls/${id}`, { method: 'PATCH', body: { ticketId } })
}
