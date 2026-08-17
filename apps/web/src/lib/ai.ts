import { api } from './api.js'

export interface SimilarTicket {
  id: string
  number: number
  subject: string
  type: string
  status: string
  priority: string
  similarity: number
}

export interface KbDraftArticle {
  id: string
  title: string
  body: string
  visibility: string
  status: string
  version: number
  created_at: string
}

export function summarizeTicket(id: string): Promise<{ id: string; summary: string }> {
  return api(`/ai/tickets/${id}/summary`, { method: 'POST', body: {} })
}

export function listSimilarTickets(id: string): Promise<{ similar: SimilarTicket[] }> {
  return api(`/ai/tickets/${id}/similar`)
}

export function draftKbArticle(id: string): Promise<{ article: KbDraftArticle }> {
  return api(`/ai/tickets/${id}/kb-draft`, { method: 'POST', body: {} })
}
