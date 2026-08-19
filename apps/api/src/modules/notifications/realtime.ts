import type { DbPool } from '../../db/pool.js'
import { publishNotification, type RealtimeNotification } from '../../core/notify.js'

const CHANNEL = 'deskos_notifications'

export interface NotificationRealtime {
  stop: () => Promise<void>
}

/**
 * LISTEN on a dedicated PostgreSQL connection so notification events continue
 * to work when the API is horizontally scaled. PostgreSQL delivers NOTIFY only
 * after the transaction that wrote the notification commits.
 */
export async function startNotificationRealtime(
  pool: DbPool,
  log: { warn: (obj: unknown, message?: string) => void; error: (obj: unknown, message?: string) => void },
): Promise<NotificationRealtime> {
  const client = await pool.connect()
  const onNotification = (message: { channel?: string; payload?: string }) => {
    if (message.channel !== CHANNEL || !message.payload) return
    try {
      publishNotification(JSON.parse(message.payload) as RealtimeNotification)
    } catch (error) {
      log.error({ err: error }, 'notification realtime payload was invalid')
    }
  }

  try {
    await client.query(`LISTEN ${CHANNEL}`)
    client.on('notification', onNotification)
  } catch (error) {
    client.release()
    log.warn({ err: error }, 'notification realtime listener unavailable')
    return { stop: async () => undefined }
  }

  return {
    stop: async () => {
      client.removeListener('notification', onNotification)
      try {
        await client.query(`UNLISTEN ${CHANNEL}`)
      } catch {
        // The database connection may already be closed during shutdown.
      }
      client.release()
    },
  }
}
