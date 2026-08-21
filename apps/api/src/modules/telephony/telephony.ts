import type { DbClient } from '../../db/pool.js'

export type CallDirection = 'inbound' | 'outbound' | 'internal'
export type CallStatus = 'ringing' | 'answered' | 'missed' | 'completed' | 'failed'

export interface NormalizedInboundCall {
  eventType: string
  providerCallId?: string
  direction: CallDirection
  fromNumber: string
  toNumber: string
  status: CallStatus
  callerName?: string
  startedAt?: string
  durationSec: number
  ticketNumber?: number
  ext: Record<string, unknown>
}

export interface CallMatch {
  status: 'matched' | 'ambiguous' | 'unmatched' | 'explicit'
  ticketId: string | null
  ticketNumber?: number
  contactId?: string | null
  contactName?: string | null
  candidates: Array<{ id: string; number: number; subject: string }>
}

export function normalizePhone(value: string | null | undefined): string {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

export function parseInboundCall(payload: Record<string, unknown>): NormalizedInboundCall {
  const stringValue = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return undefined
  }
  const eventType = stringValue('eventType', 'event', 'type') ?? 'call.received'
  const rawDirection = stringValue('direction', 'callDirection')
  const direction: CallDirection = rawDirection === 'outbound' || rawDirection === 'internal' ? rawDirection : 'inbound'
  const rawStatus = stringValue('status', 'callStatus', 'state')
  const statuses: CallStatus[] = ['ringing', 'answered', 'missed', 'completed', 'failed']
  const status: CallStatus = statuses.includes(rawStatus as CallStatus) ? rawStatus as CallStatus : eventType.includes('miss') ? 'missed' : eventType.includes('answer') ? 'answered' : 'ringing'
  const durationValue = payload.durationSec ?? payload.duration ?? payload.durationSeconds
  const durationSec = typeof durationValue === 'number' ? Math.max(0, Math.floor(durationValue)) : Number(durationValue ?? 0) || 0
  const ticketValue = payload.ticketNumber ?? payload.ticket_number
  const ticketNumber = typeof ticketValue === 'number' ? ticketValue : typeof ticketValue === 'string' && /^\d+$/.test(ticketValue) ? Number(ticketValue) : undefined
  return {
    eventType,
    providerCallId: stringValue('providerCallId', 'provider_call_id', 'callId', 'call_id', 'id'),
    direction,
    fromNumber: stringValue('fromNumber', 'from_number', 'from', 'caller') ?? '',
    toNumber: stringValue('toNumber', 'to_number', 'to', 'callee') ?? '',
    status,
    callerName: stringValue('callerName', 'caller_name', 'name'),
    startedAt: stringValue('startedAt', 'started_at', 'timestamp', 'occurredAt'),
    durationSec,
    ticketNumber,
    ext: { providerEvent: payload },
  }
}

async function findExplicitTicket(client: DbClient, tenantId: string, ticketNumber: number | undefined): Promise<{ id: string; number: number; subject: string } | null> {
  if (!ticketNumber) return null
  const row = (await client.query(
    `SELECT id, number, subject FROM tickets
      WHERE tenant_id = $1 AND number = $2 AND status NOT IN ('resolved', 'closed')`,
    [tenantId, ticketNumber],
  )).rows[0]
  return row ?? null
}

export async function matchCallToTicket(client: DbClient, tenantId: string, call: Pick<NormalizedInboundCall, 'fromNumber' | 'toNumber' | 'direction' | 'ticketNumber'>, autoMatch = true): Promise<CallMatch> {
  const explicit = await findExplicitTicket(client, tenantId, call.ticketNumber)
  if (explicit) return { status: 'explicit', ticketId: explicit.id, ticketNumber: explicit.number, candidates: [explicit] }
  if (!autoMatch) return { status: 'unmatched', ticketId: null, candidates: [] }

  const number = normalizePhone(call.direction === 'outbound' ? call.toNumber : call.fromNumber)
  if (number.length < 7) return { status: 'unmatched', ticketId: null, candidates: [] }
  const contact = (await client.query(
    `SELECT id, name FROM contacts
      WHERE tenant_id = $1 AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [tenantId, number],
  )).rows[0] as { id: string; name: string } | undefined
  const candidates = (await client.query(
    `SELECT DISTINCT t.id, t.number, t.subject, t.updated_at
       FROM tickets t
       JOIN users u ON u.id = t.requester_id
       LEFT JOIN contacts c ON c.tenant_id = t.tenant_id AND lower(c.email) = lower(u.email)
      WHERE t.tenant_id = $1 AND t.status NOT IN ('resolved', 'closed')
        AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = $2
      ORDER BY t.updated_at DESC
      LIMIT 10`,
    [tenantId, number],
  )).rows as Array<{ id: string; number: number; subject: string }>
  if (candidates.length === 1) return { status: 'matched', ticketId: candidates[0].id, ticketNumber: candidates[0].number, contactId: contact?.id ?? null, contactName: contact?.name ?? null, candidates }
  return { status: candidates.length > 1 ? 'ambiguous' : 'unmatched', ticketId: null, contactId: contact?.id ?? null, contactName: contact?.name ?? null, candidates }
}

function callActivityBody(call: { direction: CallDirection; status: CallStatus; fromNumber: string; toNumber: string; durationSec: number }, prefix = 'Call activity'): string {
  const endpoint = call.direction === 'inbound' ? call.fromNumber : call.toNumber
  const duration = call.durationSec > 0 ? ` · ${call.durationSec}s` : ''
  return `${prefix}: ${call.direction} call ${endpoint || 'unknown number'} is ${call.status}${duration}.`
}

export async function appendCallActivity(client: DbClient, tenantId: string, ticketId: string, call: { id: string; direction: CallDirection; status: CallStatus; fromNumber: string; toNumber: string; durationSec: number }, event: string, meta: Record<string, unknown> = {}): Promise<void> {
  await client.query(
    `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
     VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
    [tenantId, ticketId, callActivityBody(call), JSON.stringify({ event, callId: call.id, ...meta })],
  )
}

export async function ingestInboundCall(
  client: DbClient,
  tenantId: string,
  integration: { auto_match: boolean; auto_create_ticket: boolean },
  input: NormalizedInboundCall,
): Promise<{ call: Record<string, unknown>; match: CallMatch; created: boolean; changed: boolean }> {
  const match = await matchCallToTicket(client, tenantId, input, integration.auto_match)
  let ticketId = match.ticketId
  // Deliberately do not create a ticket for an ambiguous number. A technician
  // should choose from candidates rather than attach a call to the wrong case.
  const ext = { ...input.ext, match: { status: match.status, contactId: match.contactId ?? null, contactName: match.contactName ?? null, candidateCount: match.candidates.length } }
  const existing = input.providerCallId
    ? (await client.query('SELECT * FROM call_logs WHERE tenant_id = $1 AND provider_call_id = $2', [tenantId, input.providerCallId])).rows[0]
    : undefined
  if (existing) {
    const changed = existing.status !== input.status || Boolean(ticketId && existing.ticket_id !== ticketId)
    if (ticketId && existing.ticket_id == null) {
      await client.query('UPDATE call_logs SET ticket_id = $2, status = $3, duration_sec = $4, ext = $5::jsonb WHERE id = $1', [existing.id, ticketId, input.status, input.durationSec, JSON.stringify(ext)])
    } else {
      await client.query('UPDATE call_logs SET status = $2, duration_sec = $3, ext = $4::jsonb WHERE id = $1', [existing.id, input.status, input.durationSec, JSON.stringify(ext)])
    }
    const call = { ...existing, ticket_id: ticketId ?? existing.ticket_id, status: input.status, duration_sec: input.durationSec }
    if (changed && call.ticket_id) await appendCallActivity(client, tenantId, call.ticket_id as string, { id: call.id, direction: call.direction, status: input.status, fromNumber: call.from_number, toNumber: call.to_number, durationSec: input.durationSec }, 'telephony.call.updated', { providerEvent: input.eventType, matchStatus: match.status })
    return { call, match, created: false, changed }
  }

  const inserted = (await client.query(
    `INSERT INTO call_logs
       (tenant_id, direction, from_number, to_number, status, caller_name, started_at, duration_sec, ticket_id, provider_call_id, ext)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()), $8, $9, $10, $11::jsonb)
     RETURNING *`,
    [tenantId, input.direction, input.fromNumber, input.toNumber, input.status, input.callerName ?? null, input.startedAt ?? null, input.durationSec, ticketId, input.providerCallId ?? null, JSON.stringify(ext)],
  )).rows[0]
  if (inserted.ticket_id) await appendCallActivity(client, tenantId, inserted.ticket_id, inserted, 'telephony.call.received', { providerEvent: input.eventType, matchStatus: match.status, contactId: match.contactId ?? null })
  return { call: inserted, match, created: true, changed: true }
}
