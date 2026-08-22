import { api, getAccessToken } from './api.js'

export interface SessionDockEntry {
  id: string
  deviceName: string
  state: RemoteSessionState
  updatedAt: string
}

const SESSION_DOCK_KEY = 'deskos.activeSession'
const SESSION_DOCK_EVENT = 'deskos:session-dock'

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
  a.download = `deskos-session-${sessionId}.webm`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Upload a captured MediaRecorder blob as a session recording (multipart). */
export async function uploadRecording(id: string, blob: Blob, durationSec: number): Promise<{ recording: SessionRecording }> {
  const form = new FormData()
  form.append('recording', blob, `deskos-session-${id}.webm`)
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
