import { api } from './api.js'

export interface CannedResponse {
  id: string
  name: string
  shortcut: string
  body: string
  created_at: string
  updated_at: string
}

export function listCannedResponses(q = ''): Promise<{ cannedResponses: CannedResponse[] }> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return api(`/canned-responses${qs}`)
}

export function createCannedResponse(body: { name: string; shortcut: string; body: string }): Promise<{ cannedResponse: CannedResponse }> {
  return api('/canned-responses', { method: 'POST', body })
}

export function updateCannedResponse(id: string, body: Partial<{ name: string; shortcut: string; body: string }>): Promise<{ cannedResponse: CannedResponse }> {
  return api(`/canned-responses/${id}`, { method: 'PATCH', body })
}

export function deleteCannedResponse(id: string): Promise<{ ok: boolean }> {
  return api(`/canned-responses/${id}`, { method: 'DELETE' })
}
