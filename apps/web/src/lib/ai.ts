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

export type TriageStatus = 'idle' | 'evaluating' | 'waiting_for_user' | 'resolved' | 'handoff' | 'disabled'

export interface TriageTranscriptEntry {
  id: string
  createdAt: string
  action: 'ask_user' | 'resolve' | 'handoff'
  round: number
  message: string
  confidence: number
  rationale?: string
  evidence: string[]
  policyExplanation?: string
}

export interface TriageState {
  status: TriageStatus
  round: number
  lastQuestion?: string
  lastRunAt?: string
  lastError?: string
  lastConfidence?: number
  resolvedAt?: string
  transcript?: TriageTranscriptEntry[]
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

export function getTriageState(id: string): Promise<{ triage: TriageState }> {
  return api(`/ai/tickets/${id}/triage`)
}

export function retryTriage(id: string): Promise<{ ok: boolean; status: string }> {
  return api(`/ai/tickets/${id}/triage/retry`, { method: 'POST', body: {} })
}

export function stopTriage(id: string): Promise<{ triage: TriageState }> {
  return api(`/ai/tickets/${id}/triage/stop`, { method: 'POST', body: {} })
}
