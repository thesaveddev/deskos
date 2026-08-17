import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Client } = pg

export interface MigrationResult {
  applied: string[]
}

function migrationsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
}

export async function runMigrations(connectionString: string): Promise<MigrationResult> {
  const client = new Client({ connectionString })
  await client.connect()
  const applied: string[] = []
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const dir = migrationsDir()
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    const done = new Set(
      (await client.query('SELECT name FROM schema_migrations')).rows.map(
        (r) => r.name as string,
      ),
    )

    for (const file of files) {
      if (done.has(file)) continue
      const sql = await readFile(path.join(dir, file), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
        await client.query('COMMIT')
        applied.push(file)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`)
      }
    }
    return { applied }
  } finally {
    await client.end()
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (invokedDirectly) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL is required to run migrations')
    process.exit(1)
  }
  runMigrations(url)
    .then(({ applied }) => {
      console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations')
      process.exit(0)
    })
    .catch((err) => {
      console.error(err.message)
      process.exit(1)
    })
}
