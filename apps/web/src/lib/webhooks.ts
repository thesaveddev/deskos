import { api } from './api.js'

export type WebhookChannel = 'generic' | 'slack' | 'teams'

export interface WebhookEndpoint {
  id: string
  name: string
  url: string
  channel: WebhookChannel
  events: string[]
  enabled: boolean
  hasSecret: boolean
  createdAt: string
  updatedAt: string
}

export interface WebhookDelivery {
  id: string
  event: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  last_error: string
  created_at: string
  delivered_at: string | null
}

export function listWebhooks(): Promise<{ endpoints: WebhookEndpoint[] }> {
  return api('/webhooks')
}

export function createWebhook(body: {
  name: string
  url: string
  secret?: string
  channel?: WebhookChannel
  events?: string[]
  enabled?: boolean
}): Promise<{ endpoint: WebhookEndpoint }> {
  return api('/webhooks', { method: 'POST', body })
}

export function updateWebhook(id: string, body: Partial<{ name: string; url: string; channel: WebhookChannel; events: string[]; enabled: boolean; secret: string }>): Promise<{ endpoint: WebhookEndpoint }> {
  return api(`/webhooks/${id}`, { method: 'PATCH', body })
}

export function deleteWebhook(id: string): Promise<{ ok: boolean }> {
  return api(`/webhooks/${id}`, { method: 'DELETE' })
}

export function testWebhook(id: string): Promise<{ status: string; attempts: number; statusCode?: number }> {
  return api(`/webhooks/${id}/test`, { method: 'POST' })
}

export function listWebhookDeliveries(id: string): Promise<{ deliveries: WebhookDelivery[] }> {
  return api(`/webhooks/${id}/deliveries`)
}
