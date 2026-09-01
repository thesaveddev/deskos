import { api, getAccessToken, getActiveTenant } from './api.js'

export interface PortalTicket {
  id: string
  number: number
  type: string
  status: string
  priority: string
  subject: string
  due_response_at: string | null
  due_resolution_at: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
}

export interface PortalThread {
  id: string
  kind: string
  body: string
  author_name?: string | null
  created_at: string
}

export function portalTickets(): Promise<{ tickets: PortalTicket[] }> {
  return api('/portal/tickets')
}

export function portalTicket(number: number): Promise<{ ticket: PortalTicket; threads: PortalThread[] }> {
  return api(`/portal/tickets/${number}`)
}

export function createPortalTicket(body: { subject: string; description?: string }): Promise<{ ticket: PortalTicket }> {
  return api('/portal/tickets', { method: 'POST', body })
}

export function replyPortalTicket(number: number, body: string): Promise<{ thread: PortalThread }> {
  return api(`/portal/tickets/${number}/reply`, { method: 'POST', body: { body } })
}

export function resolvePortalTicket(number: number): Promise<{ ticket: PortalTicket }> {
  return api(`/portal/tickets/${number}/resolve`, { method: 'POST' })
}

export interface TicketRating {
  id: string
  rating: number
  comment: string
  created_at: string
}

export function portalTicketRating(number: number): Promise<{ rating: TicketRating | null }> {
  return api(`/portal/tickets/${number}/rating`)
}

export function submitPortalRating(number: number, body: { rating: number; comment?: string }): Promise<{ rating: TicketRating }> {
  return api(`/portal/tickets/${number}/rating`, { method: 'POST', body })
}

/* ── Portal attachments ── */

export interface PortalAttachment {
  id: string
  filename: string
  mime: string
  size_bytes: number
  uploader_name?: string | null
  created_at: string
}

export async function portalAttachments(number: number): Promise<{ attachments: PortalAttachment[] }> {
  return api(`/portal/tickets/${number}/attachments`)
}

function portalAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getAccessToken()
  const tenant = getActiveTenant()
  if (token) headers.authorization = `Bearer ${token}`
  if (tenant) headers['x-reydesk-tenant'] = tenant
  return headers
}

export async function uploadPortalAttachment(number: number, file: File): Promise<{ attachment: PortalAttachment }> {
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`/api/v1/portal/tickets/${number}/attachments`, {
    method: 'POST',
    body: form,
    headers: portalAuthHeaders(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error?.message ?? `Upload failed (${res.status})`)
  }
  return res.json()
}

export async function downloadPortalAttachment(id: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1/portal/attachments/${encodeURIComponent(id)}`, { headers: portalAuthHeaders() })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

/* ── Portal KB categories ── */

export interface PortalKbCategory {
  id: string
  name: string
  parent_id: string | null
  article_count: number
  created_at: string
}

export async function portalKbCategories(slug: string): Promise<{ categories: PortalKbCategory[] }> {
  const res = await fetch(`/api/v1/public/portal/${encodeURIComponent(slug)}/kb/categories`)
  if (!res.ok) return { categories: [] }
  return res.json()
}
