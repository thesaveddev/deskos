import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'
import { runMigrations } from './src/db/migrate.js'

let instance
try {
  instance = new PostgresInstance({ port: 0, username: 'postgres', password: 'probe', persistent: false, setupTimeout: 300, timeout: 180 })
  await instance.start()
  const info = instance.connectionInfo
  console.log('INSTANCE port:', info.port)

  const admin = new pg.Client({ connectionString: `postgresql://postgres:probe@${info.host}:${info.port}/postgres` })
  await admin.connect()
  await admin.query("CREATE ROLE deskos LOGIN PASSWORD 'probe'")
  await admin.query('CREATE DATABASE deskos_test OWNER deskos')
  await admin.end()

  const url = `postgresql://deskos:probe@${info.host}:${info.port}/deskos_test`

  try {
    const { applied } = await runMigrations(url)
    console.log('APPLIED:', applied.join(', '))
  } catch (err) {
    console.log('RUNMIGRATIONS ERROR:', err.message)
  }

  const c = new pg.Client({ connectionString: url })
  await c.connect()
  const m = await c.query('SELECT name FROM schema_migrations ORDER BY name')
  console.log('MIGRATIONS RECORDED:', m.rows.map((r) => r.name).join(', '))
  const t = await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  console.log('TABLES:', t.rows.map((r) => r.tablename).join(', '))
  const dg = await c.query("SELECT to_regclass('public.device_groups') AS cls")
  console.log('device_groups exists:', dg.rows[0].cls)
  await c.end()
} catch (err) {
  console.error('PROBE FAILED:', err.message)
} finally {
  try { await instance?.stop() } catch { /* noop */ }
  try { await instance?.cleanup() } catch { /* noop */ }
  console.log('CLEANED UP')
  process.exit(0)
}
