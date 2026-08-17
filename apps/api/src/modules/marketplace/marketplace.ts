import type { DbPool, DbClient } from '../../db/pool.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const q = (pool: DbPool | DbClient, text: string, values?: any[]) => (pool as any).query(text, values) as any

export interface AppRegistryEntry {
  id: string
  name: string
  slug: string
  description: string
  developer: string
  version: string
  icon_url: string | null
  capabilities: unknown
  install_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AppInstall {
  id: string
  tenant_id: string
  app_id: string
  installed_by: string
  enabled: boolean
  config: unknown
  installed_at: string
  updated_at: string
  // Joined fields
  app_name?: string
  app_slug?: string
  app_description?: string
  app_developer?: string
  app_version?: string
  app_icon_url?: string | null
  app_capabilities?: unknown
}

/* ── App Registry (platform-wide) ─────────────────────── */

export async function listApps(db: DbPool | DbClient): Promise<AppRegistryEntry[]> {
  const { rows } = await q(db, 'SELECT * FROM app_registry ORDER BY install_count DESC, name')
  return rows
}

export async function getAppBySlug(db: DbPool | DbClient, slug: string): Promise<AppRegistryEntry | null> {
  const { rows } = await q(db, 'SELECT * FROM app_registry WHERE slug = $1', [slug])
  return rows[0] ?? null
}

export async function getAppById(db: DbPool | DbClient, id: string): Promise<AppRegistryEntry | null> {
  const { rows } = await q(db, 'SELECT * FROM app_registry WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function createApp(
  db: DbPool | DbClient,
  params: {
    name: string
    slug: string
    description?: string
    developer?: string
    version?: string
    icon_url?: string | null
    capabilities?: unknown[]
    created_by?: string | null
  },
): Promise<AppRegistryEntry> {
  // Slug uniqueness is enforced by the DB UNIQUE constraint; surface a clear error.
  const existing = await getAppBySlug(db, params.slug)
  if (existing) throw new AppError(409, 'conflict', `App slug "${params.slug}" already exists`)

  const { rows } = await q(db,
    `INSERT INTO app_registry (name, slug, description, developer, version, icon_url, capabilities, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      params.name,
      params.slug,
      params.description ?? '',
      params.developer ?? '',
      params.version ?? '1.0.0',
      params.icon_url ?? null,
      JSON.stringify(params.capabilities ?? []),
      params.created_by ?? null,
    ],
  )
  return rows[0]
}

export async function updateApp(
  db: DbPool | DbClient,
  id: string,
  patch: Partial<Pick<AppRegistryEntry, 'name' | 'description' | 'developer' | 'version' | 'icon_url' | 'capabilities'>>,
): Promise<AppRegistryEntry> {
  const app = await getAppById(db, id)
  if (!app) throw new AppError(404, 'not_found', 'App not found')

  const fields: string[] = []
  const values: unknown[] = []
  let idx = 1
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const col = key === 'capabilities' ? 'capabilities' : key
    fields.push(`${col} = $${idx}`)
    values.push(key === 'capabilities' ? JSON.stringify(value) : value)
    idx++
  }
  if (fields.length === 0) return app

  fields.push(`updated_at = now()`)
  values.push(id)

  const { rows } = await q(db,
    `UPDATE app_registry SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  )
  return rows[0]
}

export async function deleteApp(db: DbPool | DbClient, id: string): Promise<void> {
  const { rowCount } = await q(db, 'DELETE FROM app_registry WHERE id = $1', [id])
  if (!rowCount) throw new AppError(404, 'not_found', 'App not found')
}

/* ── Tenant installs (RLS-scoped) ─────────────────────── */

export async function listInstalls(db: DbPool, tenantId: string): Promise<AppInstall[]> {
  const { rows } = await q(db,
    `SELECT i.*, r.name AS app_name, r.slug AS app_slug, r.description AS app_description,
            r.developer AS app_developer, r.version AS app_version, r.icon_url AS app_icon_url,
            r.capabilities AS app_capabilities
     FROM app_installs i
     JOIN app_registry r ON r.id = i.app_id
     WHERE i.tenant_id = $1
     ORDER BY i.installed_at DESC`,
    [tenantId],
  )
  return rows
}

export async function getInstall(
  db: DbPool | DbClient,
  tenantId: string,
  appId: string,
): Promise<AppInstall | null> {
  const { rows } = await q(db,
    `SELECT i.*, r.name AS app_name, r.slug AS app_slug
     FROM app_installs i
     JOIN app_registry r ON r.id = i.app_id
     WHERE i.tenant_id = $1 AND i.app_id = $2`,
    [tenantId, appId],
  )
  return rows[0] ?? null
}

export async function installApp(
  db: DbPool,
  tenantId: string,
  userId: string,
  appId: string,
  config?: Record<string, unknown>,
): Promise<AppInstall> {
  const app = await getAppById(db, appId)
  if (!app) throw new AppError(404, 'not_found', 'App not found')

  return withTenant(db, tenantId, async (client) => {
    const existing = await getInstall(client, tenantId, appId)
    if (existing) throw new AppError(409, 'conflict', 'App already installed')

    const { rows } = await q(client,
      `INSERT INTO app_installs (tenant_id, app_id, installed_by, config)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, appId, userId, JSON.stringify(config ?? {})],
    )

    // Bump install count (platform-wide).
    await q(client, 'UPDATE app_registry SET install_count = install_count + 1 WHERE id = $1', [appId])

    return rows[0]
  })
}

export async function uninstallApp(
  db: DbPool | DbClient,
  tenantId: string,
  appId: string,
): Promise<void> {
  const pool = db as DbPool
  await withTenant(pool, tenantId, async (client) => {
    const { rowCount } = await q(client,
      'DELETE FROM app_installs WHERE tenant_id = $1 AND app_id = $2',
      [tenantId, appId],
    )
    if (!rowCount) throw new AppError(404, 'not_found', 'App not installed')

    // Decrement install count (floor at 0).
    await q(client,
      'UPDATE app_registry SET install_count = GREATEST(0, install_count - 1) WHERE id = $1',
      [appId],
    )
  })
}

export async function toggleInstall(
  db: DbPool | DbClient,
  tenantId: string,
  appId: string,
  enabled: boolean,
): Promise<AppInstall> {
  const pool = db as DbPool
  return withTenant(pool, tenantId, async (client) => {
    const { rows, rowCount } = await q(client,
      `UPDATE app_installs SET enabled = $3, updated_at = now()
       WHERE tenant_id = $1 AND app_id = $2
       RETURNING *`,
      [tenantId, appId, enabled],
    )
    if (!rowCount) throw new AppError(404, 'not_found', 'App not installed')
    return rows[0]
  })
}

export async function updateInstallConfig(
  db: DbPool,
  tenantId: string,
  appId: string,
  config: Record<string, unknown>,
): Promise<AppInstall> {
  const { rows, rowCount } = await q(db,
    `UPDATE app_installs SET config = $3, updated_at = now()
     WHERE tenant_id = $1 AND app_id = $2
     RETURNING *`,
    [tenantId, appId, JSON.stringify(config)],
  )
  if (!rowCount) throw new AppError(404, 'not_found', 'App not installed')
  return rows[0]
}
