import { readFileSync } from 'node:fs'
import pg from 'pg'
import { PostgresInstance } from 'pg-embedded'

let instance
try {
  instance = new PostgresInstance({ port: 0, username: 'postgres', password: 'probe', persistent: false, setupTimeout: 300, timeout: 180 })
  await instance.start()
  const info = instance.connectionInfo
  const admin = new pg.Client({ connectionString: `postgresql://postgres:probe@${info.host}:${info.port}/postgres` })
  await admin.connect()
  await admin.query("CREATE ROLE deskos LOGIN PASSWORD 'probe'")
  await admin.query('CREATE DATABASE deskos_test OWNER deskos')
  await admin.end()

  const url = `postgresql://deskos:probe@${info.host}:${info.port}/deskos_test`
  const c = new pg.Client({ connectionString: url })
  await c.connect()

  const sql = readFileSync('src/db/migrations/0007_devices.sql', 'utf8')
  const stmts = sql.split(';').map((s) => s.trim()).filter(Boolean)

  console.log('total statements:', stmts.length)
  let i = 0
  for (const stmt of stmts) {
    i++
    const label = stmt.split('\n')[0].trim().slice(0, 70)
    try {
      await c.query(stmt)
      console.log(`[${i}] OK  ${label}`)
    } catch (err) {
      console.log(`[${i}] FAIL ${label}`)
      console.log('    ->', err.message)
      break
    }
  }

  const t = await c.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
  console.log('tables now:', t.rows.map((r) => r.tablename).join(', '))
  await c.end()
} catch (err) {
  console.error('PROBE FAILED:', err.message)
} finally {
  try { await instance?.stop() } catch { /* noop */ }
  try { await instance?.cleanup() } catch { /* noop */ }
  console.log('CLEANED UP')
  process.exit(0)
}
