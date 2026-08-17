import { readFileSync, rmSync } from 'node:fs'
import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'
import { runMigrations } from './src/db/migrate.js'

async function freshInstance(): Promise<{ url: string; stop: () => Promise<void> }> {
  const instance = new PostgresInstance({ port: 0, username: 'postgres', password: 'probe', persistent: false, setupTimeout: 300, timeout: 180 })
  await instance.start()
  const info = instance.connectionInfo
  const admin = new pg.Client({ connectionString: `postgresql://postgres:probe@${info.host}:${info.port}/postgres` })
  await admin.connect()
  await admin.query("CREATE ROLE deskos LOGIN PASSWORD 'probe'")
  await admin.query('CREATE DATABASE deskos_test OWNER deskos')
  await admin.end()
  return {
    url: `postgresql://deskos:probe@${info.host}:${info.port}/deskos_test`,
    stop: async () => { try { await instance.stop() } catch { /* noop */ } try { await instance.cleanup() } catch { /* noop */ } },
  }
}

// move 0007 out of the way so runner applies only 0001-0006
const real = 'src/db/migrations/0007_devices.sql'
const sql = readFileSync(real, 'utf8')
rmSync(real, { force: true })
const tmp = 'src/db/migrations/0007_devices.tmp'
// re-add as .tmp so it's skipped by the *.sql filter? it IS *.tmp — not .sql — skipped. 

// --- Case 1: runner applies 0001-0006, then RAW client.query(0007) ---
{
  const { url, stop } = await freshInstance()
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    await runMigrations(url)
    console.log('1: 0001-0006 applied')
    const t1 = await c.query("SELECT to_regclass('public.device_groups') AS cls")
    console.log('1: device_groups before raw run:', t1.rows[0].cls)
    try {
      await c.query(sql)
      console.log('1: RAW multi-statement: SUCCESS')
    } catch (err) {
      console.log('1: RAW multi-statement: FAIL ->', err.message)
    }
    const t2 = await c.query("SELECT to_regclass('public.device_groups') AS cls")
    console.log('1: device_groups after raw run:', t2.rows[0].cls)
    const m = await c.query('SELECT name FROM schema_migrations ORDER BY name')
    console.log('1: recorded:', m.rows.map((r) => r.name).join(', '))
  } finally {
    await c.end()
    await stop()
  }
}

// restore the file
rmSync(real, { force: true })
const { writeFileSync } = await import('node:fs')
writeFileSync(real, sql)

// --- Case 2: same but wrapped in explicit BEGIN/COMMIT like the runner ---
{
  const { url, stop } = await freshInstance()
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  try {
    await runMigrations(url)
    console.log('2: 0001-0006 applied')
    await c.query('BEGIN')
    try {
      await c.query(sql)
      await c.query('COMMIT')
      console.log('2: BEGIN-wrapped: SUCCESS')
    } catch (err) {
      console.log('2: BEGIN-wrapped: FAIL ->', err.message)
      try { await c.query('ROLLBACK') } catch { /* noop */ }
    }
    const t2 = await c.query("SELECT to_regclass('public.device_groups') AS cls")
    console.log('2: device_groups after:', t2.rows[0].cls)
  } finally {
    await c.end()
    await stop()
  }
}
process.exit(0)
