import { api, getAccessToken } from './api.js'

export interface ChatRoom {
  id: string
  name: string
  team_id?: string | null
  team_name?: string | null
  created_at: string
  message_count: number
}

export interface ChatAttachment {
  id: string
  filename: string
  mime: string
  size_bytes: number
  uploaded_by: string | null
  created_at: string
}

export interface ChatMessage {
  id: string | number
  body: string
  sender_id: string | null
  sender_name: string | null
  created_at: string
  attachments?: ChatAttachment[]
}

export function listChatRooms(): Promise<{ rooms: ChatRoom[] }> {
  return api('/chat/rooms')
}

export function createChatRoom(name: string): Promise<{ room: ChatRoom }> {
  return api('/chat/rooms', { method: 'POST', body: { name } })
}

export function listChatMessages(roomId: string): Promise<{ messages: ChatMessage[] }> {
  return api(`/chat/rooms/${roomId}/messages`)
}

export function sendChatMessage(roomId: string, body: string): Promise<{ message: ChatMessage }> {
  return api(`/chat/rooms/${roomId}/messages`, { method: 'POST', body: { body } })
}

export async function sendChatMessageWithFile(roomId: string, body: string, file: File): Promise<{ message: ChatMessage }> {
  const form = new FormData()
  form.append('body', body)
  form.append('file', file)
  const res = await fetch(`/api/v1/chat/rooms/${roomId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${getAccessToken() ?? ''}` },
    body: form,
  })
  if (!res.ok) {
    let message = `Upload failed (${res.status})`
    try { message = (await res.json()).error?.message ?? message } catch { /* ignore */ }
    throw new Error(message)
  }
  return (await res.json()) as { message: ChatMessage }
}

export async function downloadChatAttachment(id: string, filename: string): Promise<void> {
  const res = await fetch(`/api/v1/chat/attachments/${id}`, {
    headers: { authorization: `Bearer ${getAccessToken() ?? ''}` },
  })
  if (!res.ok) throw new Error(`Download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
