import { api, getAccessToken } from './api.js'

export interface SessionDockEntry {
  id: string
  deviceName: string
  state: RemoteSessionState
  updatedAt: string
}

const SESSION_DOCK_KEY = 'reydesk.activeSession'
const SESSION_DOCK_EVENT = 'reydesk:session-dock'

/** Read the last live session so the shell can offer a recovery link after a reload. */
export function activeSessionId(): string | null {
  const entry = readSessionDock()
  return entry && !['ended', 'denied', 'expired'].includes(entry.state) ? entry.id : null
}

export function readSessionDock(): SessionDockEntry | null {
  try {
    const raw = window.localStorage.getItem(SESSION_DOCK_KEY)
    return raw ? JSON.parse(raw) as SessionDockEntry : null
  } catch {
    return null
  }
}

export function writeSessionDock(entry: Omit<SessionDockEntry, 'updatedAt'>): void {
  try {
    window.localStorage.setItem(SESSION_DOCK_KEY, JSON.stringify({ ...entry, updatedAt: new Date().toISOString() }))
    window.dispatchEvent(new Event(SESSION_DOCK_EVENT))
  } catch {
    // A blocked local-storage policy must not interrupt an active remote session.
  }
}

export function clearSessionDock(id?: string): void {
  try {
    const current = readSessionDock()
    if (!id || current?.id === id) {
      window.localStorage.removeItem(SESSION_DOCK_KEY)
      window.dispatchEvent(new Event(SESSION_DOCK_EVENT))
    }
  } catch {
    // Ignore storage failures; the session itself remains authoritative.
  }
}

export const sessionDockEventName = SESSION_DOCK_EVENT

export type RemoteSessionType = 'attended' | 'unattended' | 'inspection'
export type RemoteSessionState = 'requested' | 'consent_pending' | 'connecting' | 'active' | 'reconnecting' | 'ended' | 'denied' | 'expired'

export interface SessionEvent {
  id: string | number
  actor_type: string
  actor_id: string | null
  event: string
  payload: Record<string, unknown>
  created_at: string
}

export interface RemoteSession {
  id: string
  tenant_id: string
  device_id: string
  device_name?: string
  hostname?: string
  ticket_id: string | null
  ticket_number?: number | null
  /** Total audit events for the session (device/ticket history views). */
  event_count?: number | null
  type: RemoteSessionType
  state: RemoteSessionState
  permissions: string[]
  reason: string
  requested_by: string
  requested_by_name?: string
  recording_mode: 'off' | 'metadata' | 'video'
  recording_retention_days: number
  consented_at: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  updated_at: string
}

export function getSession(id: string): Promise<{ session: RemoteSession; events: SessionEvent[] }> {
  return api(`/sessions/${id}`)
}

export function joinSession(id: string): Promise<{ session: RemoteSession; joinToken: string }> {
  return api(`/sessions/${id}/join`, { method: 'POST', body: {} })
}

export function listSessions(params: { state?: RemoteSessionState; deviceId?: string; cursor?: string; limit?: number; offset?: number } = {}): Promise<{ sessions: RemoteSession[]; total: number; nextCursor: string | null }> {
  const query = new URLSearchParams()
  if (params.state) query.set('state', params.state)
  if (params.deviceId) query.set('deviceId', params.deviceId)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/sessions${suffix}`)
}

export function createSession(body: {
  deviceId: string
  ticketId?: string
  type: RemoteSessionType
  permissions: string[]
  reason?: string
}): Promise<{ session: RemoteSession; joinToken: string }> {
  return api('/sessions', { method: 'POST', body })
}

export function endSession(id: string): Promise<{ session: RemoteSession }> {
  return api(`/sessions/${id}/end`, { method: 'POST', body: {} })
}

export interface SessionMessage {
  id: string | number
  sender_type: string
  sender_id: string | null
  sender_name?: string | null
  body: string
  created_at: string
}

export interface SessionParticipant {
  id: string
  user_id: string
  role: 'owner' | 'technician' | 'observer'
  created_at: string
  name: string
  email: string
}

export function listMessages(id: string): Promise<{ messages: SessionMessage[] }> {
  return api(`/sessions/${id}/messages`)
}

export function sendMessage(id: string, body: string): Promise<{ message: SessionMessage }> {
  return api(`/sessions/${id}/messages`, { method: 'POST', body: { body } })
}

export function listParticipants(id: string): Promise<{ participants: SessionParticipant[] }> {
  return api(`/sessions/${id}/participants`)
}

export function inviteParticipant(id: string, userId: string, role: 'technician' | 'observer'): Promise<{ participant: SessionParticipant }> {
  return api(`/sessions/${id}/invite`, { method: 'POST', body: { userId, role } })
}

export function transferSession(id: string, userId: string): Promise<{ participant: SessionParticipant }> {
  return api(`/sessions/${id}/transfer`, { method: 'POST', body: { userId } })
}

export interface AdhocSession {
  id: string
  code: string
  codeLength: number
  claimMode: 'code'
  connectUrl: string
  expiresAt: string
}

export interface AdhocSessionRecord {
  id: string
  state: string
  permissions: string[]
  reason: string
  expires_at: string
  claimed_at: string | null
  created_at: string
  device_name: string | null
  remote_session_id: string | null
  remote_session_state: RemoteSessionState | null
}

export function createAdhocSession(body: {
  permissions: string[]
  reason?: string
  expiresInMin?: number
  codeLength?: 12
}): Promise<AdhocSession> {
  return api('/adhoc-sessions', { method: 'POST', body })
}

export function listAdhocSessions(): Promise<{ sessions: AdhocSessionRecord[] }> {
  return api('/adhoc-sessions')
}

export function emailAdhocSession(id: string, code: string, to: string, mode: 'code' | 'email_link' = 'email_link'): Promise<{ ok: boolean; jobId: string; mode: string }> {
  return api(`/adhoc-sessions/${id}/email`, { method: 'POST', body: { code, to, mode } })
}

export function revokeAdhocSession(id: string): Promise<{ id: string; state: string }> {
  return api(`/adhoc-sessions/${id}/revoke`, { method: 'POST', body: {} })
}

export interface SessionRecording {
  id: string
  session_id: string
  mime: string
  size_bytes: number
  duration_sec: number
  created_at: string
  expires_at: string | null
}

export function listRecordings(id: string): Promise<{ recordings: SessionRecording[] }> {
  return api(`/sessions/${id}/recordings`)
}

/** Download a stored session recording through the authenticated API. */
export async function downloadRecording(sessionId: string, recordingId: string): Promise<void> {
  const token = getAccessToken()
  const res = await fetch(`/api/v1/sessions/${sessionId}/recordings/${recordingId}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `reydesk-session-${sessionId}.webm`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Upload a captured MediaRecorder blob as a session recording (multipart). */
export async function uploadRecording(id: string, blob: Blob, durationSec: number): Promise<{ recording: SessionRecording }> {
  const form = new FormData()
  form.append('recording', blob, `reydesk-session-${id}.webm`)
  const token = getAccessToken()
  const res = await fetch(`/api/v1/sessions/${id}/recordings?durationSec=${Math.round(durationSec)}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  })
  if (!res.ok) {
    let message = `Recording upload failed (${res.status})`
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      if (body.error?.message) message = body.error.message
    } catch {
      /* ignore parse failure */
    }
    throw new Error(message)
  }
  return (await res.json()) as { recording: SessionRecording }
}

/** Ticket-side session audit history (side rail on the ticket detail view). */
export interface TicketSessionSummary {
  id: string
  type: RemoteSessionType
  state: RemoteSessionState
  reason: string
  permissions: string[]
  consented_at: string | null
  started_at: string | null
  ended_at: string | null
  created_at: string
  device_name: string
  hostname: string | null
  requested_by_name: string | null
  /** Total audit events for the session; the panel itself shows a recent window. */
  event_count: number
  /** Denormalised recording aggregates for the outcome summary. */
  recording_count?: number | null
  recording_bytes?: number | null
  recording_duration_sec?: number | null
}

export interface TicketSessionEvent {
  id: number
  session_id: string
  actor_type: string
  event: string
  payload: Record<string, unknown>
  created_at: string
}

/**
 * Session events that represent elevated, potentially impactful endpoint
 * actions: terminal sessions, process termination, service state changes,
 * and elevation refusals. Read-only reconnaissance (listing processes,
 * services, files) is deliberately not elevated.
 */
const ELEVATED_SESSION_EVENT = /^session\.(terminal\.|processes\.terminated|services\.(started|stopped)|system\.rejected|elevation_denied)/

export function isElevatedSessionEvent(event: string): boolean {
  return ELEVATED_SESSION_EVENT.test(event)
}

export function listTicketSessions(ticketId: string): Promise<{ sessions: TicketSessionSummary[]; events: TicketSessionEvent[] }> {
  return api(`/tickets/${ticketId}/sessions`)
}

// ── Session outcome summaries ─────────────────────────────────────────
// Shared by the ticket side rail and the device detail panel so both
// audit views describe a session the same way: how long it ran, which
// permissions it operated under, and what media it produced.

/** Recording aggregates joined onto session history payloads. */
export interface SessionRecordingSummary {
  count: number
  size_bytes: number
  duration_sec: number
}

export interface SessionOutcomeFields {
  permissions: string[]
  consented_at: string | null
  started_at: string | null
  ended_at: string | null
  state: string
  /** Denormalised recording aggregates (API-provided; optional for mocks). */
  recording_count?: number | null
  recording_bytes?: number | null
  recording_duration_sec?: number | null
}

const PERMISSION_LABELS: Record<string, string> = {
  view_screen: 'View screen',
  control_input: 'Remote control',
  clipboard: 'Clipboard sync',
  elevated_terminal: 'Elevated terminal',
  file_transfer: 'File transfer',
  processes: 'Process management',
  services: 'Service management',
  reboot: 'Reboot',
}

export function sessionPermissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission.replaceAll('_', ' ')
}

/**
 * Human duration for an ended session (minutes rounded, seconds under a
 * minute), or null while it has not ended.
 */
export function sessionDurationText(outcome: Pick<SessionOutcomeFields, 'started_at' | 'ended_at' | 'state'>): string | null {
  if (!outcome.started_at || !outcome.ended_at) return null
  const started = new Date(outcome.started_at).getTime()
  const ended = new Date(outcome.ended_at).getTime()
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return null
  const seconds = Math.round((ended - started) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

/** Byte count rendered compactly (KB under 1 MB, MB thereafter). */
export function sessionBytesText(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The one-line outcome summary rendered under each session entry:
 * "18m · View screen, Remote control · 2 recordings (12.3 MB)".
 * Segments without data are omitted; sessions still in progress show
 * state-appropriate fragments instead of durations.
 */
export function sessionOutcomeSegments(outcome: SessionOutcomeFields): string[] {
  const segments: string[] = []
  const duration = sessionDurationText(outcome)
  if (duration) {
    segments.push(duration)
  } else if (outcome.state === 'active' || outcome.state === 'reconnecting') {
    segments.push('in progress')
  } else if (outcome.state === 'denied') {
    segments.push('access denied')
  } else if (outcome.state === 'expired') {
    segments.push('expired unclaimed')
  }

  const permissions = outcome.permissions ?? []
  if (permissions.length > 0) {
    segments.push(permissions.map(sessionPermissionLabel).join(', '))
  }

  const recordings = outcome.recording_count ?? 0
  if (recordings > 0) {
    const bytes = sessionBytesText(outcome.recording_bytes)
    const durationSec = outcome.recording_duration_sec
    const parts = [`${recordings} ${recordings === 1 ? 'recording' : 'recordings'}`]
    if (bytes) parts.push(bytes)
    if (typeof durationSec === 'number' && durationSec > 0) {
      const minutes = Math.round(durationSec / 60)
      if (minutes > 0) parts.push(`${minutes}m`)
      else parts.push(`${durationSec}s`)
    }
    segments.push(parts.join(' (')) + ')'
  }
  return segments
}
