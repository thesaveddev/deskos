import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { startDeviceAlertScheduler } from './modules/devices/alerts.js'
import { checkAllMonitoringPolicies } from './modules/monitoring/monitoring.js'
import { generateVapidKeyPair } from './modules/push/vapid.js'
import { startSlaScheduler } from './modules/tickets/sla.js'

function setting(name: string): string | undefined {
  return process.env[name] ?? process.env[name.replace(/^REYDESK_/, 'DESKOS_')]
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
      delete process.env.DESKOS_VAPID_PUBLIC_KEY
      if (!setting('REYDESK_VAPID_PRIVATE_KEY')) delete process.env.REYDESK_VAPID_PRIVATE_KEY
      delete process.env.DESKOS_VAPID_PRIVATE_KEY
      if (!setting('REYDESK_VAPID_SUBJECT')) delete process.env.REYDESK_VAPID_SUBJECT
      delete process.env.DESKOS_VAPID_SUBJECT
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
  startDeviceAlertScheduler(app.db, {
    offlineSec: app.config.deviceOfflineSec,
    lowDiskPct: app.config.deviceLowDiskPct,
  })
  console.log(`[devices] alert scheduler running (60s interval; offline after ${app.config.deviceOfflineSec}s, low-disk at ${app.config.deviceLowDiskPct}%)`)
  const monitoringTimer = setInterval(() => { void checkAllMonitoringPolicies(app.db).catch(() => undefined) }, 60_000)
  monitoringTimer.unref()
  console.log('[monitoring] heartbeat rules and alert escalations running (60s interval)')
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
