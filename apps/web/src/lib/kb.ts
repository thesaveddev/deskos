import { api } from './api.js'

export type KbVisibility = 'internal' | 'portal' | 'public'
export type KbStatus = 'draft' | 'review' | 'published' | 'archived'

export interface KbFolder {
  id: string
  name: string
  parent_id: string | null
  visibility: KbVisibility
  created_at: string
}

export interface KbArticle {
  id: string
  title: string
  body: string
  folder_id: string | null
  visibility: KbVisibility
  status: KbStatus
  version: number
  tags: string[]
  review_due_at: string | null
  author_name?: string | null
  created_at: string
  updated_at: string
}

export interface KbArticleVersion {
  version: number
  title: string
  author_id: string
  created_at: string
}

export interface KbFeedback {
  id: string
  helpful: boolean | null
  comment: string
  created_at: string
}

export function listFolders(): Promise<{ folders: KbFolder[] }> {
  return api('/kb/folders')
}

export function createFolder(body: { name: string; parentId?: string; visibility?: KbVisibility }): Promise<{ folder: KbFolder }> {
  return api('/kb/folders', { method: 'POST', body })
}

export function listArticles(params: { q?: string; status?: KbStatus; folderId?: string; tag?: string } = {}): Promise<{ articles: KbArticle[] }> {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.status) query.set('status', params.status)
  if (params.folderId) query.set('folderId', params.folderId)
  if (params.tag) query.set('tag', params.tag)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/kb/articles${suffix}`)
}

export function createArticle(body: {
  title: string
  body?: string
  folderId?: string
  visibility?: KbVisibility
  status?: KbStatus
  tags?: string[]
  reviewDueAt?: string
}): Promise<{ article: KbArticle }> {
  return api('/kb/articles', { method: 'POST', body })
}

export function getArticle(id: string): Promise<{ article: KbArticle; versions: KbArticleVersion[] }> {
  return api(`/kb/articles/${id}`)
}

export function updateArticle(id: string, body: {
  title?: string
  body?: string
  folderId?: string | null
  visibility?: KbVisibility
  tags?: string[]
  reviewDueAt?: string | null
}): Promise<{ article: KbArticle }> {
  return api(`/kb/articles/${id}`, { method: 'PATCH', body })
}

export function setArticleStatus(id: string, status: KbStatus): Promise<{ article: { id: string; status: KbStatus; updated_at: string } }> {
  return api(`/kb/articles/${id}/status`, { method: 'POST', body: { status } })
}

export function listArticleVersions(id: string): Promise<{ versions: KbArticleVersion[] }> {
  return api(`/kb/articles/${id}/versions`)
}

export function listPortalArticles(q?: string): Promise<{ articles: KbArticle[] }> {
  const suffix = q ? `?q=${encodeURIComponent(q)}` : ''
  return api(`/portal/kb/articles${suffix}`)
}

export function getPortalArticle(id: string): Promise<{ article: KbArticle; feedback: KbFeedback[] }> {
  return api(`/portal/kb/articles/${id}`)
}

export function submitFeedback(id: string, body: { helpful?: boolean; comment?: string }): Promise<{ feedback: KbFeedback }> {
  return api(`/portal/kb/articles/${id}/feedback`, { method: 'POST', body })
}
