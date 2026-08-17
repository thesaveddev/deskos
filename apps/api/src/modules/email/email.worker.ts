import type { AppConfig } from '../../config.js'
import type { DbPool } from '../../db/pool.js'
import { listAllEnabledChannels, pollChannel } from './email.channels.js'

export interface PollResult {
  processed: number
  created: number
  replied: number
  duplicates: number
  errors: number
  channels?: number
  lastError?: string
}

/** Legacy path: poll the single env-configured mailbox (no channels configured yet). */
export async function pollLegacyInbox(config: AppConfig['imap'], pool: DbPool): Promise<PollResult> {
  const { pollInbox } = await import('./email.legacy.js')
  return pollInbox(config, pool)
}

export class EmailWorker {
  private timer: NodeJS.Timeout | null = null
  private lastPoll: PollResult | null = null
  private lastPollAt: Date | null = null
  private lastError: string | null = null
  private running = false

  constructor(
    private config: AppConfig['imap'],
    private emailKey: string,
    private pool: DbPool,
  ) {}

  start(): void {
    if (this.timer) return
    const viaEnv = this.config.enabled ? '' : ' (no channels configured)'
    console.log(`[email] poller started — ${this.config.enabled ? 'IMAP channels' : 'no IMAP configured'}${viaEnv}`)
    void this.tick()
    this.timer = setInterval(() => void this.tick(), Math.max(10, this.config.pollIntervalSec) * 1000)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  async pollOnce(): Promise<PollResult> {
    return this.tick()
  }

  getStatus() {
    return {
      enabled: this.config.enabled,
      host: this.config.enabled ? this.config.host : null,
      running: this.running,
      lastPoll: this.lastPoll,
      lastPollAt: this.lastPollAt?.toISOString() ?? null,
      lastError: this.lastError,
    }
  }

  private async tick(): Promise<PollResult> {
    if (this.running) return { processed: 0, created: 0, replied: 0, duplicates: 0, errors: 0 }
    this.running = true
    try {
      const result = await this.pollAll()
      this.lastPoll = result
      this.lastPollAt = new Date()
      this.lastError = result.lastError ?? null
      const changed = result.created + result.replied + result.errors
      if (changed > 0) {
        console.log(
          `[email] polled: ${result.processed} processed, ${result.created} created, ${result.replied} replied, ${result.duplicates} duplicates` +
            (result.channels !== undefined ? ` (${result.channels} channels)` : '') +
            (result.errors ? `, ${result.errors} errors` : ''),
        )
      }
      return result
    } catch (err) {
      this.lastError = (err as Error).message
      console.error('[email] poll failed:', (err as Error).message)
      return { processed: 0, created: 0, replied: 0, duplicates: 0, errors: 1, lastError: (err as Error).message }
    } finally {
      this.running = false
    }
  }

  private async pollAll(): Promise<PollResult> {
    const tenants = await listAllEnabledChannels(this.pool)

    // If no tenant channels are configured, fall back to the legacy env mailbox.
    if (tenants.length === 0 && this.config.enabled) {
      return pollLegacyInbox(this.config, this.pool)
    }

    const result: PollResult = { processed: 0, created: 0, replied: 0, duplicates: 0, errors: 0, channels: 0 }

    for (const tenant of tenants) {
      for (const channel of tenant.channels) {
        result.channels = (result.channels ?? 0) + 1
        try {
          const r = await pollChannel(this.pool, channel, this.emailKey)
          result.processed += r.processed
          result.created += r.created
          result.replied += r.replied
          result.duplicates += r.duplicates
          result.errors += r.errors
        } catch (err) {
          result.errors++
          result.lastError = `[${channel.name}] ${(err as Error).message}`
        }
      }
    }

    return result
  }
}
