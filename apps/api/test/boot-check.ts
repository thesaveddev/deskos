import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { runMigrations } from '../src/db/migrate.js'

const PORT = 4099

async function main() {
  const instance = new PostgresInstance({
    port: 0,
    username: 'postgres',
    password: 'deskos_test',
    persistent: false,
    setupTimeout: 300,
    timeout: 180,
  })
  await instance.start()
  const info = instance.connectionInfo

  const admin = new pg.Client({ connectionString: `postgresql://postgres:deskos_test@${info.host}:${info.port}/postgres` })
  await admin.connect()
  await admin.query(`CREATE ROLE deskos LOGIN PASSWORD 'deskos_test'`)
  await admin.query(`CREATE DATABASE deskos_test OWNER deskos`)
  await admin.end()

  const databaseUrl = `postgresql://deskos:deskos_test@${info.host}:${info.port}/deskos_test`
  await runMigrations(databaseUrl)

  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: databaseUrl,
    DESKOS_JWT_SECRET: 'boot-check-secret-0123456789abcdef0123456789abcdef',
  } as NodeJS.ProcessEnv)
  const app = await buildApp(config)
  await app.listen({ port: PORT, host: '127.0.0.1' })

  const health = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.json())
  const meta = await fetch(`http://127.0.0.1:${PORT}/api/v1/meta`).then((r) => r.json())
  console.log('GET /healthz ->', JSON.stringify(health))
  console.log('GET /api/v1/meta ->', JSON.stringify(meta))

  const unauthorized = await fetch(`http://127.0.0.1:${PORT}/api/v1/me`)
  console.log('GET /api/v1/me (no token) ->', unauthorized.status, JSON.stringify(await unauthorized.json()))

  await app.close()
  await instance.stop()
  await instance.cleanup()
  console.log('boot check ok')
}

main().catch((e) => {
  console.error('BOOT_FAILED', e)
  process.exit(1)
})
