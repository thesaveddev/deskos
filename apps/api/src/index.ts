import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { startDeviceAlertScheduler, purgeExpiredRetiredDevices } from './modules/devices/alerts.js'
import { checkAllMonitoringPolicies } from './modules/monitoring/monitoring.js'
import { checkAssetExpiryNotices } from './modules/assets/expiry.js'
import { checkKbReviewNotices } from './modules/knowledge/review.js'
import { checkNeedsAttentionDigest } from './modules/notifications/digest.js'
import { expireStaleAdhocCodes } from './modules/remote/adhoc.routes.js'
import { generateVapidKeyPair } from './modules/push/vapid.js'
import { startSlaScheduler } from './modules/tickets/sla.js'
import { startEscalationScheduler } from './modules/tickets/escalation.scheduler.js'
import { startReminderScheduler } from './modules/tickets/reminders.routes.js'
import { checkIdentityCredentialExpiry } from './modules/ai-worker/identity-credentials.js'

function setting(name: string): string | undefined {
  return process.env[name]
}

function loadLocalEnvironment(): void {
  if (process.env.NODE_ENV === 'test') return
  if (existsSync('.env')) process.loadEnvFile('.env')

  // Development should work without asking every contributor to understand
  // Web Push internals. Generate a stable, ignored local key file once. In
  // production, keys must still be supplied through the deployment secret
  // manager so they survive restarts and can be rotated deliberately.
  if (process.env.NODE_ENV !== 'production' && !setting('REYDESK_VAPID_PUBLIC_KEY')) {
    const localPushEnv = path.resolve('.env.vapid')
    if (existsSync(localPushEnv)) {
      // A template .env may contain empty VAPID variables; clear those empty
      // values so Node can load the generated local values underneath them.
      if (!setting('REYDESK_VAPID_PUBLIC_KEY')) delete process.env.REYDESK_VAPID_PUBLIC_KEY
      if (!setting('REYDESK_VAPID_PRIVATE_KEY')) delete process.env.REYDESK_VAPID_PRIVATE_KEY
      if (!setting('REYDESK_VAPID_SUBJECT')) delete process.env.REYDESK_VAPID_SUBJECT
      process.loadEnvFile(localPushEnv)
    }
    if (!setting('REYDESK_VAPID_PUBLIC_KEY') || !setting('REYDESK_VAPID_PRIVATE_KEY')) {
      const keys = generateVapidKeyPair()
      const subject = setting('REYDESK_VAPID_SUBJECT') ?? 'mailto:admin@localhost'
      writeFileSync(localPushEnv, [
        '# Generated automatically for local ReyDesk development. Do not commit.',
        `REYDESK_VAPID_PUBLIC_KEY=${keys.publicKey}`,
        `REYDESK_VAPID_PRIVATE_KEY=${keys.privateKey}`,
        `REYDESK_VAPID_SUBJECT=${subject}`,
        '',
      ].join('\\n'), { encoding: 'utf8', mode: 0o600 })
      process.env.REYDESK_VAPID_PUBLIC_KEY = keys.publicKey
      process.env.REYDESK_VAPID_PRIVATE_KEY = keys.privateKey
      process.env.REYDESK_VAPID_SUBJECT = subject
      console.log('[push] generated local VAPID keys in .env.vapid')
    }
  }
}

loadLocalEnvironment()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function migrateWithRetry(databaseUrl: string): Promise<void> {
  const attempts = Number(setting('REYDESK_MIGRATE_ATTEMPTS') ?? 15)
  const delayMs = Number(setting('REYDESK_MIGRATE_DELAY_MS') ?? 2000)
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const { applied } = await runMigrations(databaseUrl)
      if (applied.length) console.log(`[migrate] applied ${applied.join(', ')}`)
      return
    } catch (err) {
      lastError = err
      console.warn(`[migrate] attempt ${attempt}/${attempts} failed: ${(err as Error).message}`)
      if (attempt < attempts) await sleep(delayMs)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('migrations failed')
}

async function main(): Promise<void> {
  const config = loadConfig()

  if (config.env !== 'production' || setting('REYDESK_AUTO_MIGRATE') === '1') {
    await migrateWithRetry(config.databaseUrl)
  }

  const app = await buildApp(config)
  await app.listen({ port: config.port, host: config.host })
  startSlaScheduler(app.db)
  console.log('[sla] breach scheduler running (60s interval)')
  startEscalationScheduler(app.db)
  console.log('[escalation] auto-escalation policy scheduler running (60s interval)')
  startReminderScheduler(app.db)
  console.log('[tickets] reminder scheduler running (30s interval)')
  startDeviceAlertScheduler(app.db, {
    offlineSec: app.config.deviceOfflineSec,
    lowDiskPct: app.config.deviceLowDiskPct,
    metricsRetentionDays: app.config.deviceMetricsRetentionDays,
  }, 60_000, { pool: app.db, config, fallbackProvider: app.aiProvider })
  console.log(`[devices] alert scheduler running (60s interval; offline after ${app.config.deviceOfflineSec}s, low-disk at ${app.config.deviceLowDiskPct}%)`)
  const monitoringTimer = setInterval(() => { void checkAllMonitoringPolicies(app.db).catch(() => undefined) }, 60_000)
  monitoringTimer.unref()
  console.log('[monitoring] heartbeat rules and alert escalations running (60s interval)')
  // Warranty/licence expiry notices: hourly is plenty (notices are once per
  // due date, deduped in asset_expiry_notices).
  let expiryBusy = false
  const expiryTimer = setInterval(() => {
    if (expiryBusy) return
    expiryBusy = true
    void checkAssetExpiryNotices(app.db, app.emailQueue, app.mailer, app.config.publicUrl)
      .catch(() => undefined)
      .finally(() => { expiryBusy = false })
  }, 3_600_000)
  expiryTimer.unref()
  console.log('[assets] warranty/licence expiry notices running (hourly; 30-day window)')
  // Knowledge-base overdue-review notices run on the same cadence as device
  // alerting; the ledger table dedupes per due date.
  const kbReviewTimer = setInterval(() => { void checkKbReviewNotices(app.db).catch(() => undefined) }, 60_000)
  kbReviewTimer.unref()
  console.log('[kb] overdue-review notices running (60s interval)')
  // Retired-device retention purge: hourly is plenty for a daily-horizon job;
  // REYDESK_DEVICE_PURGE_DAYS=0 disables it entirely.
  let purgeBusy = false
  const purgeTimer = setInterval(() => {
    if (purgeBusy) return
    purgeBusy = true
    void purgeExpiredRetiredDevices(app.db, app.config.devicePurgeDays)
      .catch(() => undefined)
      .finally(() => { purgeBusy = false })
  }, 3_600_000)
  purgeTimer.unref()
  if (app.config.devicePurgeDays > 0) {
    console.log(`[devices] retired-device purge running (hourly; deletes retired devices after ${app.config.devicePurgeDays}d)`)
  }
  // Needs-attention digest: one combined email per owner/manager per day.
  // REYDESK_DIGEST_ENABLED=0 disables it entirely.
  // AI worker credential expiry: notify tenant administrators within the
  // seven-day window, once per credential per day.
  let credentialExpiryBusy = false
  const credentialExpiryTimer = setInterval(() => {
    if (credentialExpiryBusy) return
    credentialExpiryBusy = true
    void checkIdentityCredentialExpiry(app.db, 7)
      .catch(() => undefined)
      .finally(() => { credentialExpiryBusy = false })
  }, 3_600_000)
  credentialExpiryTimer.unref()
  console.log('[ai] worker credential expiry notices running (hourly; 7-day window)')
  if (app.config.digestEnabled) {
    let digestBusy = false
    const digestTimer = setInterval(() => {
      if (digestBusy) return
      digestBusy = true
      void checkNeedsAttentionDigest(app.db, app.emailQueue, app.mailer, app.config.publicUrl)
        .catch(() => undefined)
        .finally(() => { digestBusy = false })
    }, 3_600_000)
    digestTimer.unref()
    console.log('[digest] needs-attention digest running (hourly; one email per recipient per day)')
  }
  // Support-code expiry hygiene: flip passed-expiry open codes to 'expired'
  // so the sessions list and code state stay truthful. Claim paths already
  // reject expired codes by timestamp, so this is display hygiene + audit
  // accuracy, not a security boundary. Five-minute cadence; unref'd.
  const adhocExpiryTimer = setInterval(() => { void expireStaleAdhocCodes(app.db).catch(() => undefined) }, 5 * 60_000)
  adhocExpiryTimer.unref()
  console.log('[remote] support-code expiry sweep running (5min interval; 24h max code lifetime)')
  if (app.emailWorker) {
    app.emailWorker.start()
  } else {
    console.warn('[email] email worker unavailable')
  }
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
