import { getAccessToken } from './api.js'

export interface ChatRealtimeMessage {
  type: 'chat.message' | 'chat.message.updated' | 'chat.typing' | 'connected' | 'disconnected'
  userId?: string
  name?: string | null
  roomId?: string
  message?: {
    id: string | number
    body: string
    sender_id: string | null
    sender_name: string | null
    created_at: string
    edited_at?: string | null
    attachments?: Array<{
      id: string
      filename: string
      mime: string
      size_bytes: number
      uploaded_by: string | null
      created_at: string
    }>
  }
}

export interface ChatRealtimeTyping {
  userId: string
  name: string | null
}

export interface ChatRealtimeOptions {
  roomId: string
  tenantId: string
  onMessage: (message: ChatRealtimeMessage) => void
  onTyping?: (typing: ChatRealtimeTyping) => void
  onConnected?: () => void
  onDisconnected?: () => void
  onError?: (error: Event) => void
}

export interface ChatRealtimeConnection {
  close: () => void
  /** Tell the room the local user is typing (throttled server-side). */
  sendTyping: () => void
}

export function connectChatWebSocket(options: ChatRealtimeOptions): ChatRealtimeConnection {
  let socket: WebSocket | null = null
  let stopped = false
  let retryTimer: number | undefined
  let retryDelay = 1000

  const connect = () => {
    if (stopped) return

    const token = getAccessToken()
    if (!token) {
      // Retry silently until token is available
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        connect()
      }, 2000)
      return
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    const url = `${protocol}://${host}/api/v1/chat/ws?token=${encodeURIComponent(token)}&tid=${encodeURIComponent(options.tenantId)}&room=${encodeURIComponent(options.roomId)}`

    socket = new WebSocket(url)

    socket.onopen = () => {
      retryDelay = 1000
    }

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as ChatRealtimeMessage
        if (data.type === 'connected') {
          options.onConnected?.()
        } else if (data.type === 'disconnected') {
          options.onDisconnected?.()
        } else if (data.type === 'chat.typing') {
          if (data.userId) options.onTyping?.({ userId: data.userId, name: data.name ?? null })
        } else {
          options.onMessage(data)
        }
      } catch {
        // Ignore malformed messages
      }
    }

    socket.onerror = (event) => {
      options.onError?.(event)
    }

    socket.onclose = () => {
      if (stopped) return
      // Reconnect with exponential backoff
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined
        retryDelay = Math.min(retryDelay * 2, 30000)
        connect()
      }, retryDelay)
    }
  }

  connect()

  return {
    close: () => {
      stopped = true
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
      }
      if (socket) {
        socket.close()
        socket = null
      }
    },
    sendTyping: () => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ type: 'chat.typing' })) } catch { /* closing */ }
      }
    },
  }
}
