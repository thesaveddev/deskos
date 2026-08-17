import { api } from './api.js'

export type NotificationChannel = 'in_app' | 'email'

export interface NotificationPreference {
  kind: string
  enabled: boolean
  channels: NotificationChannel[]
}

export function listNotificationPreferences(): Promise<{ preferences: NotificationPreference[] }> {
  return api('/notification-preferences')
}

export function upsertNotificationPreference(kind: string, body: {
  enabled?: boolean
  channels?: NotificationChannel[]
}): Promise<{ preference: { kind: string; enabled: boolean; channels: string[]; updated_at: string } }> {
  return api(`/notification-preferences/${encodeURIComponent(kind)}`, { method: 'PUT', body })
}

export function resetNotificationPreference(kind: string): Promise<{ ok: boolean; kind: string }> {
  return api(`/notification-preferences/${encodeURIComponent(kind)}`, { method: 'DELETE' })
}
