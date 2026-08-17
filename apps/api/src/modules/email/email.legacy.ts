import { ImapFlow } from 'imapflow'
import type { AppConfig } from '../../config.js'
import type { DbPool } from '../../db/pool.js'
import { processRawEmail } from './email.service.js'
import type { PollResult } from './email.worker.js'

/**
 * Poll a single env-configured mailbox and route everything to the oldest
 * tenant. Only used as a fallback when no per-tenant email channels exist.
 */
export async function pollInbox(config: AppConfig['imap'], pool: DbPool): Promise<PollResult> {
  const result: PollResult = { processed: 0, created: 0, replied: 0, duplicates: 0, errors: 0 }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993 || config.tls,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  })

  await client.connect()

  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ seen: false })
      if (!uids || uids.length === 0) return result

      for (const uid of uids) {
        const raw = await client.fetchOne(uid, { source: true, envelope: true })
        if (!raw || !raw.source) continue

        try {
          const res = await processRawEmail(pool, raw.source.toString('utf8'))
          result.processed++
          if (res.action === 'created') result.created++
          else if (res.action === 'replied') result.replied++
          else if (res.action === 'duplicate') result.duplicates++
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        } catch (err) {
          result.errors++
          result.lastError = (err as Error).message
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }

  return result
}
