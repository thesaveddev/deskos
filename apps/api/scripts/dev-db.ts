import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'
import { runMigrations } from '../src/db/migrate.js'

const PORT = Number(process.env.DESKOS_DEV_DB_PORT ?? 5432)
const APP_USER = 'deskos'
const APP_PASSWORD = 'deskos_dev_only'
const APP_DB = 'deskos'
const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.devdb')

async function main() {
  const instance = new PostgresInstance({
    port: PORT,
    username: 'postgres',
    password: APP_PASSWORD,
    persistent: true,
    dataDir: path.join(DATA_DIR, 'data'),
    setupTimeout: 300,
    timeout: 180,
  })
  await instance.start()
  const info = instance.connectionInfo

  const admin = new pg.Client({
    connectionString: `postgresql://postgres:${APP_PASSWORD}@${info.host}:${info.port}/postgres`,
  })
  await admin.connect()
  const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [APP_USER])
  if (!role.rowCount) {
    await admin.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}'`)
  }
  const db = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [APP_DB])
  if (!db.rowCount) {
    await admin.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`)
  }
  await admin.end()

  const databaseUrl = `postgresql://${APP_USER}:${APP_PASSWORD}@${info.host}:${info.port}/${APP_DB}`
  const { applied } = await runMigrations(databaseUrl)
  console.log(`[dev-db] postgres ready on port ${info.port}${applied.length ? ` (migrated: ${applied.join(', ')})` : ' (schema up to date)'}`)
  console.log(`[dev-db] DATABASE_URL=${databaseUrl}`)

  const keepAlive = setInterval(() => {
    /* keeps the process (and the embedded postgres) running */
  }, 60_000)

  const shutdown = async () => {
    console.log('[dev-db] stopping...')
    clearInterval(keepAlive)
    try { await instance.stop() } catch { /* ignore */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[dev-db] failed:', err)
  process.exit(1)
})
