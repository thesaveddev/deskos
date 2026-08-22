import { AppError } from '../../core/errors.js'
import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from '../../core/crypto.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { adClient, type AdAction, type AdClient, type AdComputer, type AdConnectionSecrets } from './ldap.js'

export interface AdConnectionInput {
  name: string
  host: string
  port?: number
  useSsl?: boolean
  baseDn: string
  bindDn: string
  bindPassword: string
  enabled?: boolean
}

export interface AdConnectionRow {
  id: string
  tenant_id: string
  name: string
  host: string
  port: number
  use_ssl: boolean
  base_dn: string
  bind_dn: string
  bind_password_enc: string
  enabled: boolean
  created_at: Date
  updated_at: Date
}

export function maskConnection(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    useSsl: row.use_ssl,
    baseDn: row.base_dn,
    bindDn: row.bind_dn,
    hasSecret: (row.bind_password_enc as string).length > 0,
    bindPasswordMasked: maskSecret(),
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function secretsFor(row: AdConnectionRow, emailKey: string): AdConnectionSecrets {
  if (!isEncryptedSecret(row.bind_password_enc)) {
    throw new AppError(500, 'invalid_state', 'Bind password is not encrypted')
  }
  return {
    host: row.host,
    port: row.port,
    useSsl: row.use_ssl,
    baseDn: row.base_dn,
    bindDn: row.bind_dn,
    bindPassword: decryptSecret(row.bind_password_enc, emailKey),
  }
}

export async function getConnection(pool: DbPool, tenantId: string, connectionId: string): Promise<AdConnectionRow> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM ad_connections WHERE id = $1', [connectionId])
    if (!rows[0]) throw AppError.notFound('Active Directory connection not found')
    return rows[0] as AdConnectionRow
  })
}

export async function listConnections(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM ad_connections ORDER BY created_at')
    return rows.map((r: Record<string, unknown>) => maskConnection(r))
  })
}

export async function createConnection(
  pool: DbPool,
  tenantId: string,
  input: AdConnectionInput,
  emailKey: string,
  actorId: string,
): Promise<string> {
  const secretEnc = encryptSecret(input.bindPassword, emailKey)
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ad_connections
         (tenant_id, name, host, port, use_ssl, base_dn, bind_dn, bind_password_enc, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [tenantId, input.name, input.host, input.port ?? 389, input.useSsl ?? false, input.baseDn, input.bindDn, secretEnc, input.enabled ?? true, actorId],
    )
    return rows[0].id as string
  })
}

export async function updateConnection(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  input: Partial<AdConnectionInput>,
  emailKey: string,
): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT id FROM ad_connections WHERE id = $1', [connectionId])
    if (!rows[0]) throw AppError.notFound('Active Directory connection not found')

    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.host !== undefined) push('host', input.host)
    if (input.port !== undefined) push('port', input.port)
    if (input.useSsl !== undefined) push('use_ssl', input.useSsl)
    if (input.baseDn !== undefined) push('base_dn', input.baseDn)
    if (input.bindDn !== undefined) push('bind_dn', input.bindDn)
    if (input.enabled !== undefined) push('enabled', input.enabled)
    if (input.bindPassword !== undefined && input.bindPassword.length > 0) {
      push('bind_password_enc', encryptSecret(input.bindPassword, emailKey))
    }
    push('updated_at', new Date())
    params.push(connectionId)
    await client.query(`UPDATE ad_connections SET ${sets.join(', ')} WHERE id = $${idx}`, params)
  })
}

export async function deleteConnection(pool: DbPool, tenantId: string, connectionId: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('DELETE FROM ad_connections WHERE id = $1 RETURNING id', [connectionId])
    if (!rows[0]) throw AppError.notFound('Active Directory connection not found')
  })
}

export async function testConnection(
  client: AdClient,
  row: AdConnectionRow,
  emailKey: string,
): Promise<{ ok: boolean; users?: number; error?: string }> {
  try {
    const users = await client.listUsers(secretsFor(row, emailKey))
    return { ok: true, users: users.length }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Connection failed' }
  }
}

export interface DiagnosticStep {
  name: string
  label: string
  status: 'pending' | 'running' | 'ok' | 'warn' | 'error'
  detail?: string
  durationMs?: number
}

export async function diagnoseConnection(
  client: AdClient,
  row: AdConnectionRow,
  emailKey: string,
): Promise<DiagnosticStep[]> {
  const secrets = secretsFor(row, emailKey)
  const steps: DiagnosticStep[] = []
  const start = () => Date.now()
  const elapsed = (t: number) => Date.now() - t

  // Step 1: TCP connectivity to the LDAP server
  steps.push({ name: 'tcp', label: `TCP connectivity to ${secrets.host}:${secrets.port}`, status: 'running' })
  let t = start()
  try {
    const { Socket } = await import('net')
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket()
      socket.setTimeout(5_000)
      socket.on('connect', () => { socket.destroy(); resolve() })
      socket.on('timeout', () => { socket.destroy(); reject(new Error('Connection timed out')) })
      socket.on('error', (err) => { socket.destroy(); reject(err) })
      socket.connect(secrets.port, secrets.host)
    })
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'ok', detail: `TCP port ${secrets.port} is reachable`, durationMs: elapsed(t) }
  } catch (err) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'error', detail: err instanceof Error ? err.message : 'TCP connection failed', durationMs: elapsed(t) }
    return steps
  }

  // Step 2: LDAP bind with credentials
  steps.push({ name: 'bind', label: `LDAP bind as ${secrets.bindDn}`, status: 'running' })
  t = start()
  try {
    // Attempt a real LDAP bind via the client's listUsers which does a bind internally.
    // If bind fails, listUsers will throw.
    const users = await client.listUsers(secrets)
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'ok', detail: `Bind successful, ${users.length} user(s) accessible`, durationMs: elapsed(t) }
  } catch (err) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'error', detail: err instanceof Error ? err.message : 'LDAP bind failed — check bind DN and password', durationMs: elapsed(t) }
    return steps
  }

  // Step 3: User search
  steps.push({ name: 'users', label: `LDAP search — users under ${secrets.baseDn}`, status: 'running' })
  t = start()
  let userCount = 0
  try {
    const users = await client.listUsers(secrets)
    userCount = users.length
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: userCount > 0 ? 'ok' : 'warn', detail: userCount > 0 ? `${userCount} user(s) found` : 'No users found — check base DN and search filter', durationMs: elapsed(t) }
  } catch (err) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'error', detail: err instanceof Error ? err.message : 'User search failed', durationMs: elapsed(t) }
  }

  // Step 4: Computer/device search
  steps.push({ name: 'devices', label: 'LDAP search — computer objects', status: 'running' })
  t = start()
  try {
    const computers = await client.listComputers(secrets)
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: computers.length > 0 ? 'ok' : 'warn', detail: `${computers.length} computer object(s) found`, durationMs: elapsed(t) }
  } catch (err) {
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: 'warn', detail: err instanceof Error ? err.message : 'Computer search failed — may need extended permissions', durationMs: elapsed(t) }
  }

  return steps
}

export interface SyncRunResult {
  fetched: number
  created: number
  updated: number
}

export async function syncDirectory(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  emailKey: string,
  client: AdClient = adClient,
): Promise<SyncRunResult> {
  const row = await getConnection(pool, tenantId, connectionId)
  return withTenant(pool, tenantId, async (db) => {
    const runRes = await db.query(
      `INSERT INTO ad_sync_runs (tenant_id, connection_id, status) VALUES ($1, $2, 'started') RETURNING id`,
      [tenantId, connectionId],
    )
    const runId = runRes.rows[0].id as string
    try {
      const users = await client.listUsers(secretsFor(row, emailKey))
      let created = 0
      let updated = 0
      for (const u of users) {
        const email = u.mail || u.upn
        if (!email) continue
        const existing = await db.query('SELECT id FROM contacts WHERE tenant_id = $1 AND email = $2', [tenantId, email])
        const ext = JSON.stringify({ objectId: u.objectId, upn: u.upn, source: 'ad' })
        if (existing.rows[0]) {
          await db.query(
            `UPDATE contacts SET name = $3, department = $4, account_status = $5, ext_identity = $6::jsonb,
                    staff_id = $7, updated_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [existing.rows[0].id, tenantId, u.displayName, u.department ?? null, u.accountEnabled ? 'active' : 'disabled', ext, u.employeeId ?? null],
          )
          updated += 1
        } else {
          await db.query(
            `INSERT INTO contacts (tenant_id, type, name, email, department, account_status, ext_identity, staff_id)
             VALUES ($1, 'end_user', $2, $3, $4, $5, $6::jsonb, $7)`,
            [tenantId, u.displayName, email, u.department ?? null, u.accountEnabled ? 'active' : 'disabled', ext, u.employeeId ?? null],
          )
          created += 1
        }
      }
      await db.query(
        `UPDATE ad_sync_runs SET status = 'ok', fetched = $2, created = $3, updated = $4, finished_at = now() WHERE id = $1`,
        [runId, users.length, created, updated],
      )
      return { fetched: users.length, created, updated }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Sync failed'
      await db.query(`UPDATE ad_sync_runs SET status = 'error', error = $2, finished_at = now() WHERE id = $1`, [runId, message.slice(0, 1000)])
      throw err
    }
  })
}

export interface DeviceSyncResult {
  fetched: number
  created: number
  updated: number
}

/** Pull on-prem AD computer objects and upsert them as directory-discovered devices. */
export async function syncDevices(
  pool: DbPool,
  tenantId: string,
  connectionId: string,
  emailKey: string,
  client: AdClient = adClient,
): Promise<DeviceSyncResult> {
  const row = await getConnection(pool, tenantId, connectionId)
  return withTenant(pool, tenantId, async (db) => {
    const computers: AdComputer[] = await client.listComputers(secretsFor(row, emailKey))
    let created = 0
    let updated = 0
    for (const c of computers) {
      if (!c.objectId || !c.name) continue
      const existing = await db.query(
        'SELECT id FROM devices WHERE tenant_id = $1 AND managed_by = $2 AND directory_object_id = $3',
        [tenantId, 'ad', c.objectId],
      )
      if (existing.rows[0]) {
        await db.query(
          `UPDATE devices SET name = $4, hostname = $5, os = $6, os_version = $7, serial_number = $8, updated_at = now()
            WHERE id = $1 AND tenant_id = $2 AND managed_by = $3`,
          [existing.rows[0].id, tenantId, 'ad', c.name, c.dnsHostName || c.name, c.os, c.osVersion, c.serialNumber ?? ''],
        )
        updated += 1
      } else {
        await db.query(
          `INSERT INTO devices (tenant_id, name, hostname, os, os_version, source, managed_by, directory_object_id, serial_number)
           VALUES ($1, $2, $3, $4, $5, 'directory', 'ad', $6, $7)`,
          [tenantId, c.name, c.dnsHostName || c.name, c.os, c.osVersion, c.objectId, c.serialNumber ?? ''],
        )
        created += 1
      }
    }
    return { fetched: computers.length, created, updated }
  })
}

export async function listSyncRuns(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT r.*, c.name AS connection_name
         FROM ad_sync_runs r
         LEFT JOIN ad_connections c ON c.id = r.connection_id
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
  action: AdAction,
  upn: string,
  newPassword?: string,
  client: AdClient = adClient,
): Promise<{ id: string; status: string; detail: string }> {
  const row = await getConnection(pool, tenantId, connectionId)
  let status: 'ok' | 'error' = 'ok'
  let detail: string
  try {
    detail = await client.runAccountAction(secretsFor(row, emailKey), action, upn, newPassword)
  } catch (err) {
    status = 'error'
    detail = err instanceof Error ? err.message : 'Action failed'
  }
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query(
      `INSERT INTO ad_actions (tenant_id, connection_id, actor_id, action, target_upn, status, detail)
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
         FROM ad_actions a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN ad_connections c ON c.id = a.connection_id
        ORDER BY a.created_at DESC LIMIT 100`,
    )
    return rows
  })
}
