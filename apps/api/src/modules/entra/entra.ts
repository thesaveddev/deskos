import { AppError } from '../../core/errors.js'
import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from '../../core/crypto.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import type { EntraGraphClient, EntraUser } from './graph.js'
import { graphClient } from './graph.js'

export interface EntraConnectionInput {
  name: string
  azureTenantId: string
  clientId: string
  clientSecret: string
  enabled?: boolean
}

export interface EntraConnectionRow {
  id: string
  tenant_id: string
  name: string
  azure_tenant_id: string
  client_id: string
  client_secret_enc: string
  enabled: boolean
  created_at: Date
  updated_at: Date
}

export function maskConnection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    azureTenantId: row.azure_tenant_id,
    clientId: row.client_id,
    hasSecret: (row.client_secret_enc as string).length > 0,
    clientSecretMasked: maskSecret(),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function decryptSecretChecked(row: EntraConnectionRow, emailKey: string): string {
  if (!isEncryptedSecret(row.client_secret_enc)) {
    throw new AppError(500, 'invalid_state', 'Client secret is not encrypted')
  }
  return decryptSecret(row.client_secret_enc, emailKey)
}

export async function getConnection(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
): Promise<EntraConnectionRow> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM entra_connections WHERE id = $1',
      [connectionId],
    )
    if (!rows[0]) throw AppError.notFound('Entra connection not found')
    return rows[0] as EntraConnectionRow
  })
}

export async function listConnections(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM entra_connections ORDER BY created_at')
    return rows.map((r: Record<string, unknown>) => maskConnection(r))
  })
}

export async function createConnection(
  pool: DbPool,
  tenantId: string,
  input: EntraConnectionInput,
  emailKey: string,
  actorId: string,
): Promise<string> {
  const secretEnc = encryptSecret(input.clientSecret, emailKey)
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO entra_connections
         (tenant_id, name, azure_tenant_id, client_id, client_secret_enc, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [tenantId, input.name, input.azureTenantId, input.clientId, secretEnc, input.enabled ?? true, actorId],
    )
    return rows[0].id as string
  })
}

export async function updateConnection(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  input: Partial<EntraConnectionInput>,
  emailKey: string,
): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM entra_connections WHERE id = $1',
      [connectionId],
    )
    if (!rows[0]) throw AppError.notFound('Entra connection not found')

    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.azureTenantId !== undefined) push('azure_tenant_id', input.azureTenantId)
    if (input.clientId !== undefined) push('client_id', input.clientId)
    if (input.enabled !== undefined) push('enabled', input.enabled)
    if (input.clientSecret !== undefined && input.clientSecret.length > 0) {
      push('client_secret_enc', encryptSecret(input.clientSecret, emailKey))
    }
    push('updated_at', new Date())
    params.push(connectionId)
    await client.query(`UPDATE entra_connections SET ${sets.join(', ')} WHERE id = $${idx}`, params)
  })
}

export async function deleteConnection(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('DELETE FROM entra_connections WHERE id = $1 RETURNING id', [connectionId])
    if (!rows[0]) throw AppError.notFound('Entra connection not found')
  })
}

/** Test that a connection can exchange credentials for a Graph token. */
export async function testConnection(
  client: EntraGraphClient,
  row: EntraConnectionRow,
  emailKey: string,
): Promise<{ ok: boolean; users?: number; error?: string }> {
  try {
    const users = await client.listUsers({
      azureTenantId: row.azure_tenant_id,
      clientId: row.client_id,
      clientSecret: decryptSecretChecked(row, emailKey),
    })
    return { ok: true, users: users.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
  }
}

export interface SyncRunResult {
  fetched: number
  created: number
  updated: number
}

/** Pull directory users from Graph and upsert them into tenant contacts. */
export async function syncDirectory(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  emailKey: string,
  client: EntraGraphClient = graphClient,
): Promise<SyncRunResult> {
  const row = await getConnection(pool, tenantId, connectionId)
  return withTenant(pool, tenantId, async (db) => {
    const runRes = await db.query(
      `INSERT INTO directory_sync_runs (tenant_id, connection_id, status)
       VALUES ($1, $2, 'started') RETURNING id`,
      [tenantId, connectionId],
    )
    const runId = runRes.rows[0].id as string
    try {
      const users = await client.listUsers({
        azureTenantId: row.azure_tenant_id,
        clientId: row.client_id,
        clientSecret: decryptSecretChecked(row, emailKey),
      })
      let created = 0
      let updated = 0
      for (const u of users) {
        const email = u.mail || u.upn
        if (!email) continue
        const existing = await db.query('SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2', [tenantId, email])
        const ext = JSON.stringify({ objectId: u.objectId, upn: u.upn })
        if (existing.rows[0]) {
          await db.query(
            `UPDATE contacts SET name = $3, department = $4, account_status = $5, ext_identity = $6::jsonb,
                    staff_id = $7, job_title = $8, updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [existing.rows[0].id, tenantId, u.displayName, u.department ?? null, u.accountEnabled ? 'active' : 'disabled', ext, u.employeeId ?? null, u.jobTitle ?? null],
          )
          updated += 1
        } else {
          await db.query(
            `INSERT INTO contacts (tenant_id, type, name, email, department, account_status, ext_identity, staff_id, job_title)
             VALUES ($1, 'end_user', $2, $3, $4, $5, $6::jsonb, $7, $8)`,
            [tenantId, u.displayName, email, u.department ?? null, u.accountEnabled ? 'active' : 'disabled', ext, u.employeeId ?? null, u.jobTitle ?? null],
          )
          created += 1
        }
      }
      await db.query(
        `UPDATE directory_sync_runs SET status = 'ok', fetched = $2, created = $3, updated = $4, finished_at = now()
          WHERE id = $1`,
        [runId, users.length, created, updated],
      )
      return { fetched: users.length, created, updated }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed'
      await db.query(
        `UPDATE directory_sync_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`,
        [runId, message.slice(0, 1000)],
      )
      throw err
    }
  })
}

export interface DeviceSyncResult {
  fetched: number
  created: number
  updated: number
}

/** Pull Intune-managed devices from Graph and upsert them as directory-discovered devices. */
export async function syncDevices(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  emailKey: string,
  client: EntraGraphClient = graphClient,
): Promise<DeviceSyncResult> {
  const row = await getConnection(pool, tenantId, connectionId)
  return withTenant(pool, tenantId, async (db) => {
    const devices = await client.listDevices({
      azureTenantId: row.azure_tenant_id,
      clientId: row.client_id,
      clientSecret: decryptSecretChecked(row, emailKey),
    })
    let created = 0
    let updated = 0
    for (const d of devices) {
      if (!d.objectId || !d.name) continue
      const existing = await db.query(
        'SELECT id FROM devices WHERE tenant_id = $1 AND managed_by = $2 AND directory_object_id = $3',
        [tenantId, 'intune', d.objectId],
      )
      const lastSeen = d.lastSyncDateTime ? new Date(d.lastSyncDateTime) : null
      if (existing.rows[0]) {
        await db.query(
          `UPDATE devices SET name = $4, hostname = $4, os = $5, os_version = $6, serial_number = $7,
                  manufacturer = $8, model = $9, directory_last_seen_at = $10, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND managed_by = $3`,
          [
            existing.rows[0].id, tenantId, 'intune', d.name,
            d.os || '', d.osVersion || '', d.serialNumber ?? '', d.manufacturer ?? '', d.model ?? '',
            lastSeen,
          ],
        )
        updated += 1
      } else {
        await db.query(
          `INSERT INTO devices (tenant_id, name, hostname, os, os_version, source, managed_by, directory_object_id,
                                serial_number, manufacturer, model, directory_last_seen_at)
           VALUES ($1, $2, $2, $3, $4, 'directory', 'intune', $5, $6, $7, $8, $9)`,
          [tenantId, d.name, d.os || '', d.osVersion || '', d.objectId, d.serialNumber ?? '', d.manufacturer ?? '', d.model ?? '', lastSeen],
        )
        created += 1
      }
    }
    return { fetched: devices.length, created, updated }
  })
}

export async function listSyncRuns(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT r.*, c.name AS connection_name
         FROM directory_sync_runs r
         LEFT JOIN entra_connections c ON c.id = r.connection_id
        ORDER BY r.started_at DESC LIMIT 100`,
    )
    return rows
  })
}

export async function runAccountAction(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  emailKey: string,
  actorId: string,
  action: 'resetPassword' | 'requireMfa',
  upn: string,
  newPassword?: string,
  client: EntraGraphClient = graphClient,
): Promise<{ id: string; status: string; detail: string }> {
  const row = await getConnection(pool, tenantId, connectionId)
  let status: 'ok' | 'error' = 'ok'
  let detail: string
  try {
    detail = await client.runAccountAction(
      { azureTenantId: row.azure_tenant_id, clientId: row.client_id, clientSecret: decryptSecretChecked(row, emailKey) },
      action,
      upn,
      newPassword,
    )
  } catch (err) {
    status = 'error'
    detail = err instanceof Error ? err.message : 'Action failed'
  }
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO entra_actions (tenant_id, connection_id, actor_id, action, target_upn, status, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [tenantId, connectionId, actorId, action, upn, status, detail.slice(0, 1000)],
    )
    return { id: rows[0].id as string, status, detail }
  })
}

export async function listActions(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT a.*, u.name AS actor_name, c.name AS connection_name
         FROM entra_actions a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN entra_connections c ON c.id = a.connection_id
        ORDER BY a.created_at DESC LIMIT 100`,
    )
    return rows
  })
}

export async function listContacts(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM contacts ORDER BY name LIMIT 500')
    return rows
  })
}

export type { EntraUser }
