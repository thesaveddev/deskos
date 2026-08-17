import pg from 'pg'

const { Pool } = pg

export type DbPool = pg.Pool
export type DbClient = pg.PoolClient

export function createPool(connectionString: string, options: { max?: number } = {}): DbPool {
  return new Pool({
    connectionString,
    max: options.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  })
}

/**
 * Execute `fn` inside a transaction with Postgres row-level security scoped to
 * the given tenant. `app.tenant_id` is set for the duration of the transaction
 * so every RLS-protected table is filtered (and checked) against it.
 *
 * This is the ONLY supported way to touch tenant-scoped data.
 */
export async function withTenant<T>(
  pool: DbPool,
  tenantId: string,
  fn: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    throw err
  } finally {
    client.release()
  }
}
