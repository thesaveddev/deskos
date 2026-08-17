import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'
import { runMigrations } from '../src/db/migrate.js'

export const DB_URL_FILE = path.join(tmpdir(), 'deskos-test-db-url.json')

const APP_USER = 'deskos'
const APP_PASSWORD = 'deskos_test'
const APP_DB = 'deskos_test'

let instance: PostgresInstance | undefined

/**
 * Boots an embedded PostgreSQL and prepares a least-privilege application role.
 *
 * pg-embedded creates a single `postgres` superuser (password = the configured
 * password) and does not create the configured `username`. We therefore create
 * a dedicated, NON-superuser role to own the schema. This matters: superusers
 * bypass row-level security, so a superuser app role would make the tenant
 * isolation guarantees untestable. Owning the tables + FORCE ROW LEVEL SECURITY
 * means RLS applies to the app role exactly as it does in production.
 */
export default async function setup(): Promise<() => Promise<void>> {
  instance = new PostgresInstance({
    port: 0,
    username: 'postgres',
    password: APP_PASSWORD,
    persistent: false,
    setupTimeout: 300,
    timeout: 180,
  })
  await instance.start()
  const info = instance.connectionInfo

  const admin = new pg.Client({
    connectionString: `postgresql://postgres:${APP_PASSWORD}@${info.host}:${info.port}/postgres`,
    connectionTimeoutMillis: 15_000,
  })
  await admin.connect()
  await admin.query(`CREATE ROLE ${APP_USER} LOGIN PASSWORD '${APP_PASSWORD}'`)
  await admin.query(`CREATE DATABASE ${APP_DB} OWNER ${APP_USER}`)
  await admin.end()

  const databaseUrl = `postgresql://${APP_USER}:${APP_PASSWORD}@${info.host}:${info.port}/${APP_DB}`
  writeFileSync(DB_URL_FILE, JSON.stringify({ databaseUrl, port: info.port }))

  await runMigrations(databaseUrl)
  console.log(`[global-setup] embedded postgres ready on port ${info.port} (app role: ${APP_USER})`)

  return async function teardown() {
    try {
      await instance?.stop()
    } catch {
      /* already stopped */
    }
    try {
      await instance?.cleanup()
    } catch {
      /* best effort */
    }
  }
}
