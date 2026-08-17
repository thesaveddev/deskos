import { api } from './api.js'

export interface ChatRoom {
  id: string
  name: string
  created_at: string
  message_count: number
}

export interface ChatMessage {
  id: string | number
  body: string
  sender_id: string | null
  sender_name: string | null
  created_at: string
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
