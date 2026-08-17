import { readFileSync } from 'node:fs'
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

// --- Case A: full file via runner (baseline repro) ---
{
  const { url, stop } = await freshInstance()
  try {
    await runMigrations(url)
    console.log('A (full file via runner): SUCCESS')
  } catch (err) {
    console.log('A (full file via runner): FAIL ->', err.message)
  } finally {
    await stop()
  }
}

// --- Case B: file WITHOUT the function, via runner ---
{
  const { url, stop } = await freshInstance()
  const sql = readFileSync('src/db/migrations/0007_devices.sql', 'utf8')
  const withoutFn = sql.split('CREATE OR REPLACE FUNCTION')[0]
  const { writeFileSync } = await import('node:fs')
  const tmp = 'src/db/migrations/0007_devices_no_fn.sql'
  writeFileSync(tmp, withoutFn)
  try {
    await runMigrations(url)
    console.log('B (without function): SUCCESS')
  } catch (err) {
    console.log('B (without function): FAIL ->', err.message)
  } finally {
    const { rmSync } = await import('node:fs')
    rmSync(tmp, { force: true })
    await stop()
  }
}
process.exit(0)
