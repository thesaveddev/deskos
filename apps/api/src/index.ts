import { existsSync } from 'node:fs'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { runMigrations } from './db/migrate.js'
import { startDeviceAlertScheduler } from './modules/devices/alerts.js'
import { startSlaScheduler } from './modules/tickets/sla.js'

if (process.env.NODE_ENV !== 'test' && existsSync('.env')) {
  process.loadEnvFile('.env')
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function migrateWithRetry(databaseUrl: string): Promise<void> {
  const attempts = Number(process.env.DESKOS_MIGRATE_ATTEMPTS ?? 15)
  const delayMs = Number(process.env.DESKOS_MIGRATE_DELAY_MS ?? 2000)
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

  if (config.env !== 'production' || process.env.DESKOS_AUTO_MIGRATE === '1') {
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
