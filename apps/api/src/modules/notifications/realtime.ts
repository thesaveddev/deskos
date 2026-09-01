import type { DbClient, DbPool } from '../../db/pool.js'
import { publishNotification, type RealtimeNotification } from '../../core/notify.js'

const CHANNEL = 'reydesk_notifications'

export interface NotificationRealtime {
  stop: () => Promise<void>
}

/**
 * LISTEN on a dedicated PostgreSQL connection so notification events continue
 * to work when the API is horizontally scaled. PostgreSQL delivers NOTIFY only
 * after the transaction that wrote the notification commits.
 *
 * The listener connection is self-healing: if PostgreSQL restarts, the
 * connection idles out, or the network blips, the client is re-acquired and
 * re-subscribed with backoff. A dead listener previously silenced every SSE
 * push until the API process restarted — the bell only updated after the user
 * clicked it and forced a manual reload.
 */
export async function startNotificationRealtime(
  pool: DbPool,
  log: { warn: (obj: unknown, message?: string) => void; error: (obj: unknown, message?: string) => void },
): Promise<NotificationRealtime> {
  let stopped = false
  let client: DbClient | null = null
  let retryTimer: NodeJS.Timeout | null = null
  let watchdog: NodeJS.Timeout | null = null
  let reconnectDelay = 1_000

  const scheduleReconnect = () => {
    if (stopped || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void attach()
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  }

  const attach = async () => {
    if (stopped) return
    try {
      const next = await pool.connect()
      await next.query(`LISTEN ${CHANNEL}`)
      if (stopped) {
        next.release()
        return
      }
      client = next
      reconnectDelay = 1_000

      const onNotification = (message: { channel?: string; payload?: string }) => {
        if (message.channel !== CHANNEL || !message.payload) return
        try {
          publishNotification(JSON.parse(message.payload) as RealtimeNotification)
        } catch (error) {
          log.error({ err: error }, 'notification realtime payload was invalid')
        }
      }

      const detach = () => {
        next.removeListener('notification', onNotification)
        if (client === next) client = null
      }

      next.on('notification', onNotification)
      next.once('error', () => {
        detach()
        try {
          next.release()
        } catch {
          // The pool may already have dropped the failed client.
        }
        scheduleReconnect()
      })
      next.once('end', () => {
        detach()
        try {
          next.release()
        } catch {
          // Ignore release races after the socket closed.
        }
        scheduleReconnect()
      })
    } catch (error) {
      log.warn({ err: error }, 'notification realtime listener unavailable')
      scheduleReconnect()
    }
  }

  // Watchdog: if the listener connection silently stops delivering (rare pool
  // quirks that do not surface as error/end), probe it and recreate it.
  watchdog = setInterval(() => {
    if (stopped) return
    const current = client
    if (!current) {
      scheduleReconnect()
      return
    }
    current.query('SELECT 1').catch(() => {
      // The failing query triggers the client's error path, which reconnects.
    })
  }, 60_000)
  watchdog.unref()

  await attach()

  return {
    stop: async () => {
      stopped = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      if (watchdog) {
        clearInterval(watchdog)
        watchdog = null
      }
      const current = client
      client = null
      if (!current) return
      try {
        await current.query(`UNLISTEN ${CHANNEL}`)
      } catch {
        // The database connection may already be closed during shutdown.
      }
      current.removeAllListeners('notification')
      current.release()
    },
  }
}