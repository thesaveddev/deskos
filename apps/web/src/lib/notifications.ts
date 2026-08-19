import { api, getAccessToken } from './api.js'

export type NotificationChannel = 'in_app' | 'email' | 'push'

export interface AppNotification {
  id: string
  kind: string
  subject_type: string | null
  subject_id: string | null
  body: string
  read_at: string | null
  created_at: string
}

export function listNotifications(): Promise<{ notifications: AppNotification[] }> {
  return api('/notifications')
}

export function markNotificationsRead(input: { ids?: string[]; all?: boolean }): Promise<{ updated: number }> {
  return api('/notifications/read', { method: 'POST', body: input })
}

export interface NotificationStreamOptions {
  tenantId: string
  onNotification: (notification: AppNotification) => void
  onConnected?: () => void
}

/**
 * Keep the notification bell live over an authenticated SSE stream. The stream
 * reconnects with backoff after a proxy, network, or API restart; it does not
 * poll the notifications endpoint.
 */
export function openNotificationStream(options: NotificationStreamOptions): () => void {
  const controller = new AbortController()
  let stopped = false
  let retryTimer: number | undefined
  let retryDelay = 1_000

  const connect = async (): Promise<void> => {
    if (stopped) return
    try {
      const token = getAccessToken()
      if (!token) throw new Error('notification stream requires authentication')
      const response = await fetch('/api/v1/notifications/stream', {
        headers: {
          authorization: `Bearer ${token}`,
          'x-deskos-tenant': options.tenantId,
          accept: 'text/event-stream',
        },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`notification stream failed (${response.status})`)

      retryDelay = 1_000
      options.onConnected?.()
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let event = 'message'
      let data = ''

      const dispatch = () => {
        if (event === 'notification' && data) {
          try {
            options.onNotification(JSON.parse(data) as AppNotification)
          } catch {
            // Ignore malformed events; the next event remains usable.
          }
        }
        event = 'message'
        data = ''
      }

      while (!stopped) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const lines = buffer.split(/\\r?\\n/)
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line === '') {
            dispatch()
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            data += line.slice(5).trim()
          }
        }
      }
      dispatch()
      if (!stopped) throw new Error('notification stream closed')
    } catch {
      if (stopped) return
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        void connect()
      }, retryDelay)
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
  }

  void connect()
  return () => {
    stopped = true
    controller.abort()
    if (retryTimer !== undefined) window.clearTimeout(retryTimer)
  }
}

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
