import type { DbClient, DbPool } from '../../db/pool.js'
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
  let client: DbClient | null = null
  try {
    client = await pool.connect()
  } catch (error) {
    log.warn({ err: error }, 'notification realtime listener unavailable')
    return { stop: async () => undefined }
  }
  const listenerClient = client
  const onNotification = (message: { channel?: string; payload?: string }) => {
    if (message.channel !== CHANNEL || !message.payload) return
    try {
      publishNotification(JSON.parse(message.payload) as RealtimeNotification)
    } catch (error) {
      log.error({ err: error }, 'notification realtime payload was invalid')
    }
  }

  try {
    await listenerClient.query(`LISTEN ${CHANNEL}`)
    listenerClient.on('notification', onNotification)
  } catch (error) {
    listenerClient.release()
    log.warn({ err: error }, 'notification realtime listener unavailable')
    return { stop: async () => undefined }
  }

  return {
    stop: async () => {
      listenerClient.removeListener('notification', onNotification)
      try {
        await listenerClient.query(`UNLISTEN ${CHANNEL}`)
      } catch {
        // The database connection may already be closed during shutdown.
      }
      listenerClient.release()
    },
  }
}
