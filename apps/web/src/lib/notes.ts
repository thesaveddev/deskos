import { api } from './api.js'

export interface NoteCategory {
  id: string
  tenant_id: string
  user_id: string
  name: string
  color: string
  created_at: string
  updated_at: string
}

export interface Note {
  id: number
  tenant_id: string
  user_id: string
  title: string
  body: string
  color: string
  category_id: string | null
  category_name?: string | null
  category_color?: string | null
  image_data: string | null
  position_x: number
  position_y: number
  width: number
  height: number
  is_pinned: boolean
  created_at: string
  updated_at: string
}

export const NOTE_COLORS = [
  { name: 'yellow', bg: '#fef3c7', text: '#78350f', border: '#f59e0b' },
  { name: 'green', bg: '#d1fae5', text: '#065f46', border: '#10b981' },
  { name: 'blue', bg: '#dbeafe', text: '#1e40af', border: '#3b82f6' },
  { name: 'pink', bg: '#fce7f3', text: '#9d174d', border: '#ec4899' },
  { name: 'purple', bg: '#ede9fe', text: '#5b21b6', border: '#8b5cf6' },
  { name: 'orange', bg: '#ffedd5', text: '#9a3412', border: '#f97316' },
  { name: 'gray', bg: '#f3f4f6', text: '#374151', border: '#9ca3af' },
]

export function getColorStyle(colorName: string) {
  return NOTE_COLORS.find((c) => c.name === colorName) || NOTE_COLORS[0]
}

export function listNotes(): Promise<{ notes: Note[] }> { return api('/notes') }
export function listNoteCategories(): Promise<{ categories: NoteCategory[] }> { return api('/notes/categories') }
export function createNoteCategory(data: { name: string; color: string }): Promise<{ category: NoteCategory }> { return api('/notes/categories', { method: 'POST', body: data }) }
export function deleteNoteCategory(id: string): Promise<{ ok: boolean }> { return api(`/notes/categories/${id}`, { method: 'DELETE' }) }

export function createNote(data: { title?: string; body?: string; color?: string; category_id?: string | null; image_data?: string | null; position_x?: number; position_y?: number; width?: number; height?: number }): Promise<{ note: Note }> {
  return api('/notes', { method: 'POST', body: data })
}

export function updateNote(id: number, data: Partial<Pick<Note, 'title' | 'body' | 'color' | 'category_id' | 'image_data' | 'position_x' | 'position_y' | 'width' | 'height' | 'is_pinned'>>): Promise<{ note: Note }> {
  return api(`/notes/${id}`, { method: 'PATCH', body: data })
}

export function deleteNote(id: number): Promise<{ ok: boolean }> { return api(`/notes/${id}`, { method: 'DELETE' }) }
