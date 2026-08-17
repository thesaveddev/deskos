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
}

export interface ListCallsFilters {
  ticketId?: string
  direction?: CallDirection
  status?: CallStatus
  q?: string
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
