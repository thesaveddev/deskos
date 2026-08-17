import { api } from './api.js'

export interface EmailChannel {
  id: string
  name: string
  address: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapTls: boolean
  enabled: boolean
  hasPassword: boolean
  passwordMasked: string
  createdAt: string
  updatedAt: string
}

export interface EmailChannelInput {
  name: string
  address: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPass: string
  imapTls: boolean
  enabled?: boolean
}

export interface EmailStatus {
  enabled: boolean
  host: string | null
  running: boolean
  lastPoll: {
    processed: number
    created: number
    replied: number
    duplicates: number
    errors: number
  } | null
  lastPollAt: string | null
  lastError: string | null
}

export interface PollResult {
  processed: number
  created: number
  replied: number
  duplicates: number
  errors: number
}

export function listEmailChannels(): Promise<{ channels: EmailChannel[] }> {
  return api('/email/channels')
}

export function createEmailChannel(input: EmailChannelInput): Promise<{ id: string }> {
  return api('/email/channels', { method: 'POST', body: input })
}

export function updateEmailChannel(id: string, input: Partial<EmailChannelInput>): Promise<{ ok: boolean }> {
  return api(`/email/channels/${id}`, { method: 'PATCH', body: input })
}

export function deleteEmailChannel(id: string): Promise<{ ok: boolean }> {
  return api(`/email/channels/${id}`, { method: 'DELETE' })
}

export function testEmailChannel(id: string): Promise<{ ok: boolean; unseen?: number }> {
  return api(`/email/channels/${id}/test`, { method: 'POST', body: {} })
}

/** Test raw connection settings before saving (no channel id required). */
export function testEmailConnection(input: {
  imapHost: string
  imapPort: number
  imapUser: string
  imapPass: string
  imapTls: boolean
}): Promise<{ ok: boolean; unseen?: number; error?: string }> {
  return api('/email/channels/test', { method: 'POST', body: input })
}

export function pollEmailChannel(id: string): Promise<PollResult> {
  return api(`/email/channels/${id}/poll`, { method: 'POST', body: {} })
}

export function getEmailStatus(): Promise<EmailStatus> {
  return api('/email/status')
}

export function pollAllEmailChannels(): Promise<PollResult> {
  return api('/email/poll', { method: 'POST', body: {} })
}
