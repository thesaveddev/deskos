import { api } from './api.js'

export type KbVisibility = 'internal' | 'portal' | 'public'
export type KbStatus = 'draft' | 'review' | 'published' | 'archived'
export type KbRelationType = 'related' | 'prerequisite' | 'follow_up'

export interface KbFolder {
  id: string
  name: string
  parent_id: string | null
  visibility: KbVisibility
  article_count?: number
  created_at: string
  updated_at?: string
}

export interface KbArticle {
  id: string
  title: string
  summary: string
  body: string
  folder_id: string | null
  visibility: KbVisibility
  status: KbStatus
  version: number
  tags: string[]
  review_due_at: string | null
  view_count: number
  helpful_count: number
  not_helpful_count: number
  published_at?: string | null
  last_reviewed_at?: string | null
  author_name?: string | null
  created_at: string
  updated_at: string
}

export interface KbArticleVersion {
  version: number
  title: string
  summary: string
  body?: string
  author_id: string
  created_at: string
}

export interface KbRelation {
  id?: string
  relation_type: KbRelationType
  related_article_id: string
  related_title: string
  related_summary?: string
  related_status?: KbStatus
  related_visibility?: KbVisibility
  created_at?: string
}

export interface KbFeedback {
  id: string
  helpful: boolean | null
  comment: string
  created_at: string
}

export interface KbPagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface KbOverview {
  summary: {
    total: number
    drafts: number
    review: number
    published: number
    archived: number
    overdue: number
    views: number
    helpful: number
    not_helpful: number
  }
  topArticles: KbArticle[]
  overdueArticles: Array<Pick<KbArticle, 'id' | 'title' | 'review_due_at' | 'visibility'>>
}

export function listFolders(): Promise<{ folders: KbFolder[] }> {
  return api('/kb/folders')
}

export function createFolder(body: { name: string; parentId?: string | null; visibility?: KbVisibility }): Promise<{ folder: KbFolder }> {
  return api('/kb/folders', { method: 'POST', body })
}

export function updateFolder(id: string, body: { name?: string; parentId?: string | null; visibility?: KbVisibility }): Promise<{ folder: KbFolder }> {
  return api(`/kb/folders/${id}`, { method: 'PATCH', body })
}

export function deleteFolder(id: string): Promise<void> {
  return api(`/kb/folders/${id}`, { method: 'DELETE' })
}

export function getKbOverview(): Promise<KbOverview> {
  return api('/kb/overview')
}

export function listArticles(params: { q?: string; status?: KbStatus; folderId?: string; tag?: string; visibility?: KbVisibility; sort?: 'updated' | 'views' | 'helpful' | 'review_due' | 'title'; page?: number; pageSize?: number } = {}): Promise<{ articles: KbArticle[]; pagination: KbPagination }> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/kb/articles${suffix}`)
}

export function createArticle(body: {
  title: string
  summary?: string
  body?: string
  folderId?: string | null
  visibility?: KbVisibility
  status?: KbStatus
  tags?: string[]
  reviewDueAt?: string | null
}): Promise<{ article: KbArticle }> {
  return api('/kb/articles', { method: 'POST', body })
}

export function getArticle(id: string): Promise<{ article: KbArticle; versions: KbArticleVersion[]; relations: KbRelation[] }> {
  return api(`/kb/articles/${id}`)
}

export function updateArticle(id: string, body: {
  title?: string
  summary?: string
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

export function getArticleVersion(id: string, version: number): Promise<{ version: KbArticleVersion }> {
  return api(`/kb/articles/${id}/versions/${version}`)
}

export function createRelation(id: string, body: { relatedArticleId: string; relationType?: KbRelationType }): Promise<{ relation: KbRelation }> {
  return api(`/kb/articles/${id}/relations`, { method: 'POST', body })
}

export function deleteRelation(id: string, relationId: string): Promise<void> {
  return api(`/kb/articles/${id}/relations/${relationId}`, { method: 'DELETE' })
}

export function listPortalArticles(params: { q?: string; tag?: string; folderId?: string; page?: number; pageSize?: number } = {}): Promise<{ articles: KbArticle[]; pagination: KbPagination }> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/portal/kb/articles${suffix}`)
}

export function getPortalArticle(id: string): Promise<{ article: KbArticle; feedback: KbFeedback[]; relations: KbRelation[] }> {
  return api(`/portal/kb/articles/${id}`)
}

export function submitFeedback(id: string, body: { helpful?: boolean; comment?: string }): Promise<{ feedback: KbFeedback }> {
  return api(`/portal/kb/articles/${id}/feedback`, { method: 'POST', body })
}
