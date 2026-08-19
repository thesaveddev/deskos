import { api } from './api.js'

export interface Ticket {
  id: string
  number: number
  type: string
  status: string
  priority: string
  subject: string
  requester_id: string
  requester_name?: string
  assignee_id: string | null
  assignee_name?: string
  lock_user_id?: string | null
  lock_user_name?: string | null
  team_id: string | null
  team_name?: string
  device_id: string | null
  due_response_at: string | null
  due_resolution_at: string | null
  first_response_at: string | null
  sla_response_breached: boolean
  sla_resolution_breached: boolean
  resolved_at: string | null
  service_id: string | null
  ext: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

export interface TicketDevice {
  id: string
  name: string
  hostname: string
  os: string
  os_version: string
  arch: string
  ip_address: string
  agent_version: string
  last_seen_at: string | null
}

export interface Thread {
  id: string
  kind: 'message' | 'internal_note' | 'system_event' | 'session_record' | 'ai_summary' | 'ai_triage'
  visibility: 'public' | 'internal'
  body: string
  author_name?: string | null
  meta: Record<string, unknown>
  created_at: string
}

export function listTickets(params: Record<string, string> = {}): Promise<{ tickets: Ticket[]; total: number; nextCursor: string | null }> {
  const qs = new URLSearchParams(params).toString()
  return api(`/tickets${qs ? `?${qs}` : ''}`)
}

export function getTicket(id: string): Promise<{ ticket: Ticket; device: TicketDevice | null; threads: Thread[] }> {
  return api(`/tickets/${id}`)
}

export function createTicket(body: {
  subject: string
  description?: string
  priority?: string
  type?: string
  deviceId?: string
  serviceId?: string
  rootCause?: string
  workaround?: string
  risk?: 'low' | 'medium' | 'high'
  implementationPlan?: string
  backoutPlan?: string
  scheduledAt?: string
  requesterName?: string
  requesterEmail?: string
  requesterPhone?: string
  requesterDepartment?: string
  requesterCompany?: string
  requesterLocation?: string
}): Promise<{ ticket: Ticket }> {
  return api('/tickets', { method: 'POST', body })
}

export interface TicketLink {
  id: string
  link_type: string
  target_type: string
  target_id: string
  target_number: number | null
  target_subject: string | null
  target_asset_name: string | null
  target_kb_title: string | null
  created_at: string
}

export function listTicketLinks(id: string): Promise<{ links: TicketLink[] }> {
  return api(`/tickets/${id}/links`)
}

export function addTicketLink(id: string, body: { linkType: string; targetType: string; targetId: string }): Promise<{ link: TicketLink | null; duplicate?: boolean }> {
  return api(`/tickets/${id}/links`, { method: 'POST', body })
}

export function removeTicketLink(linkId: string): Promise<{ ok: boolean }> {
  return api(`/links/${linkId}`, { method: 'DELETE' })
}

export function replyTicket(id: string, body: string, visibility: 'public' | 'internal'): Promise<{ thread: Thread }> {
  return api(`/tickets/${id}/reply`, { method: 'POST', body: { body, visibility } })
}

export function setTicketStatus(id: string, status: string): Promise<{ ticket: Ticket }> {
  return api(`/tickets/${id}/status`, { method: 'POST', body: { status } })
}

export function assignTicket(id: string, assigneeId: string | null): Promise<{ ticket: Ticket }> {
  return api(`/tickets/${id}/assign`, { method: 'POST', body: { assigneeId } })
}

export function updateTicket(id: string, body: Record<string, unknown>): Promise<{ ticket: Ticket }> {
  return api(`/tickets/${id}`, { method: 'PATCH', body })
}

export function ticketCounts(): Promise<{ byStatus: Array<{ status: string; n: number }>; mine: number; unassigned: number; slaRisk: number }> {
  return api('/tickets/counts')
}

export interface Attachment {
  id: string
  filename: string
  mime: string
  size_bytes: number
  uploader_name?: string
  created_at: string
}

export function listAttachments(ticketId: string): Promise<{ attachments: Attachment[] }> {
  return api(`/tickets/${ticketId}/attachments`)
}

export async function downloadAttachment(token: string, id: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1/attachments/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export async function uploadAttachment(token: string, ticketId: string, file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/v1/tickets/${ticketId}/attachments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  })
  if (!res.ok) {
    let message = `Upload failed (${res.status})`
    try { message = (await res.json()).error?.message ?? message } catch { /* ignore */ }
    throw new Error(message)
  }
  return (await res.json()).attachment
}

export function searchAll(q: string): Promise<{ tickets: Array<{ id: string; number: number; subject: string; status: string }>; users: Array<{ id: string; name: string; email: string }> }> {
  return api(`/search?q=${encodeURIComponent(q)}`)
}

export const STATUS_LABELS: Record<string, string> = {
  new: 'New',
  open: 'Open',
  in_progress: 'In progress',
  pending_user: 'Pending user',
  pending_vendor: 'Pending vendor',
  escalated: 'Escalated',
  resolved: 'Resolved',
  closed: 'Closed',
}

export const ACTIVE_STATUSES = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated']

export function slaSummary(t: Ticket): { label: string; tone: 'ok' | 'warn' | 'crit' | 'muted' } {
  const now = Date.now()
  if (t.status === 'resolved' || t.status === 'closed') return { label: 'Done', tone: 'muted' }
  if (t.sla_response_breached || t.sla_resolution_breached) return { label: 'Breached', tone: 'crit' }

  const responseDue = t.due_response_at && !t.first_response_at ? new Date(t.due_response_at).getTime() : null
  const resolutionDue = t.due_resolution_at && !t.resolved_at ? new Date(t.due_resolution_at).getTime() : null
  const next = [responseDue, resolutionDue].filter((d): d is number => d !== null).sort((a, b) => a - b)[0]
  if (!next) return { label: '—', tone: 'muted' }

  const mins = Math.round((next - now) / 60_000)
  if (mins < 0) return { label: 'Breached', tone: 'crit' }
  const label = mins < 60 ? `${mins}m` : mins < 60 * 24 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
  return { label: `due ${label}`, tone: mins < 60 ? 'warn' : 'ok' }
}

export function formatWhen(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ── Escalation, forwarding, merge, bulk ──

export interface Escalation {
  id: number
  ticket_id: string
  level: number
  from_team_id: string | null
  to_team_id: string | null
  from_assignee_id: string | null
  to_assignee_id: string | null
  reason: string
  escalated_by: string | null
  escalated_by_name?: string
  created_at: string
}

export interface TicketActivityEntry {
  id: number
  ticket_id: string
  actor_id: string | null
  actor_name?: string
  action: string
  detail: Record<string, unknown>
  created_at: string
}

export interface Team {
  id: string
  name: string
  accepts_tickets?: boolean
}

export function escalateTicket(id: string, data: { to_team_id?: string; to_assignee_id?: string; reason: string }): Promise<{ escalation: Escalation }> {
  return api(`/tickets/${id}/escalate`, { method: 'POST', body: data })
}

export function getTicketEscalations(id: string): Promise<{ escalations: Escalation[] }> {
  return api(`/tickets/${id}/escalations`)
}

export function forwardTicket(id: string, data: { to_team_id?: string; to_assignee_id?: string; note?: string }): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/forward`, { method: 'POST', body: data })
}

export function mergeTickets(primaryId: string, duplicateIds: string[]): Promise<{ ok: boolean }> {
  return api('/tickets/merge', { method: 'POST', body: { primary_id: primaryId, duplicate_ids: duplicateIds } })
}

export function bulkUpdateTickets(ticketIds: string[], updates: { status?: string; assignee_id?: string; team_id?: string; priority?: string }): Promise<{ updated: number }> {
  return api('/tickets/bulk', { method: 'POST', body: { ticket_ids: ticketIds, ...updates } })
}

export function getTicketActivity(id: string): Promise<{ activity: TicketActivityEntry[] }> {
  return api(`/tickets/${id}/activity`)
}

export function listTeams(): Promise<{ teams: Team[] }> {
  return api('/teams')
}

export function listTeamMembers(teamId: string): Promise<{ members: Array<{ id: string; name: string; email: string }> }> {
  return api(`/teams/${teamId}/members`)
}

// ── Ticket locking ──

export interface TicketLockInfo {
  id: number
  ticket_id: string
  locked_by: string
  locked_by_name?: string
  locked_by_email?: string
  locked_at: string
  expires_at: string
  heartbeat_at: string
}

export function getTicketLock(id: string): Promise<{ lock: TicketLockInfo | null; is_mine: boolean }> {
  return api(`/tickets/${id}/lock`)
}

export function lockTicket(id: string): Promise<{ lock: TicketLockInfo }> {
  return api(`/tickets/${id}/lock`, { method: 'POST' })
}

export function unlockTicket(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/lock`, { method: 'DELETE' })
}

export function heartbeatLock(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/lock/heartbeat`, { method: 'POST' })
}

export function forceUnlockTicket(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/lock/force`, { method: 'DELETE' })
}

export function startViewingTicket(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/viewing`, { method: 'POST' })
}

export function stopViewingTicket(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/viewing`, { method: 'DELETE' })
}

export function heartbeatViewing(id: string): Promise<{ ok: boolean }> {
  return api(`/tickets/${id}/viewing/heartbeat`, { method: 'POST' })
}

export function getTicketViewers(id: string): Promise<{ viewers: Array<{ user_id: string; name: string; email: string; viewing_at: string }> }> {
  return api(`/tickets/${id}/viewers`)
}
