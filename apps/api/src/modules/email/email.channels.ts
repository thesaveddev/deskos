import { ImapFlow } from 'imapflow'
import { AppError } from '../../core/errors.js'
import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from '../../core/crypto.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { processRawEmail } from './email.service.js'

export interface ChannelInput {
  name: string
  address: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPass: string
  imapTls: boolean
  enabled?: boolean
}

export interface ChannelRow {
  id: string
  tenantId: string
  name: string
  address: string
  imapHost: string
  imapPort: number
  imapUser: string
  imapPassEnc: string
  imapTls: boolean
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}

/** Map a DB row (snake_case) to the camelCase domain shape. */
export function rowToChannel(row: Record<string, unknown>): ChannelRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    name: row.name as string,
    address: row.address as string,
    imapHost: row.imap_host as string,
    imapPort: row.imap_port as number,
    imapUser: row.imap_user as string,
    imapPassEnc: row.imap_pass_enc as string,
    imapTls: row.imap_tls as boolean,
    enabled: row.enabled as boolean,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  }
}

function decryptChannelPassword(channel: ChannelRow, emailKey: string): string {
  if (!isEncryptedSecret(channel.imapPassEnc)) {
    throw new AppError(500, 'invalid_state', 'Channel password is not encrypted')
  }
  return decryptSecret(channel.imapPassEnc, emailKey)
}

export async function listChannels(pool: DbPool, tenantId: string): Promise<unknown[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM email_channels ORDER BY created_at')
    return rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      address: r.address,
      imapHost: r.imap_host,
      imapPort: r.imap_port,
      imapUser: r.imap_user,
      imapTls: r.imap_tls,
      enabled: r.enabled,
      hasPassword: (r.imap_pass_enc as string).length > 0,
      passwordMasked: maskSecret(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
  })
}

export async function createChannel(pool: DbPool, tenantId: string, input: ChannelInput, emailKey: string): Promise<{ id: string }> {
  const passEnc = encryptSecret(input.imapPass, emailKey)
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO email_channels
         (tenant_id, name, address, imap_host, imap_port, imap_user, imap_pass_enc, imap_tls, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        tenantId,
        input.name,
        input.address,
        input.imapHost,
        input.imapPort,
        input.imapUser,
        passEnc,
        input.imapTls,
        input.enabled ?? true,
      ],
    )
    return { id: rows[0].id as string }
  })
}

export async function updateChannel(
  pool: DbPool,
  tenantId: string,
  channelId: string,
  input: Partial<ChannelInput>,
  emailKey: string,
): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT id FROM email_channels WHERE id = $1 AND tenant_id = $2',
      [channelId, tenantId],
    )
    if (rows.length === 0) throw new AppError(404, 'not_found', 'Email channel not found')

    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }

    if (input.name !== undefined) push('name', input.name)
    if (input.address !== undefined) push('address', input.address)
    if (input.imapHost !== undefined) push('imap_host', input.imapHost)
    if (input.imapPort !== undefined) push('imap_port', input.imapPort)
    if (input.imapUser !== undefined) push('imap_user', input.imapUser)
    if (input.imapTls !== undefined) push('imap_tls', input.imapTls)
    if (input.enabled !== undefined) push('enabled', input.enabled)
    if (input.imapPass !== undefined && input.imapPass.length > 0) {
      push('imap_pass_enc', encryptSecret(input.imapPass, emailKey))
    }
    push('updated_at', new Date())

    if (sets.length === 0) return
    params.push(channelId, tenantId)
    await client.query(`UPDATE email_channels SET ${sets.join(', ')} WHERE id = $${idx++} AND tenant_id = $${idx++}`, params)
  })
}

export async function deleteChannel(pool: DbPool, tenantId: string, channelId: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT id FROM email_channels WHERE id = $1 AND tenant_id = $2', [
      channelId,
      tenantId,
    ])
    if (rows.length === 0) throw new AppError(404, 'not_found', 'Email channel not found')
    await client.query('DELETE FROM email_channels WHERE id = $1 AND tenant_id = $2', [channelId, tenantId])
  })
}

export async function getChannel(
  pool: DbPool,
  tenantId: string,
  channelId: string,
): Promise<ChannelRow> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM email_channels WHERE id = $1 AND tenant_id = $2', [
      channelId,
      tenantId,
    ])
    if (rows.length === 0) throw new AppError(404, 'not_found', 'Email channel not found')
    return rowToChannel(rows[0] as Record<string, unknown>)
  })
}

export interface ConnectionTest {
  ok: boolean
  error?: string
  unseen?: number
}

export interface ConnectionConfig {
  host: string
  port: number
  user: string
  pass: string
  tls?: boolean
}

/** Build a user-readable error message from an imapflow failure. */
function describeImapError(err: unknown): string {
  const e = err as { code?: string; responseText?: string; responseStatus?: string; message?: string }
  const reason = e.responseText?.trim()
  if (reason) return `IMAP ${e.responseStatus ?? 'error'}: ${reason}`
  if (e.code) return `${e.code}: ${e.message ?? ''}`.trim()
  return e.message ?? 'Connection failed'
}

async function connectAndProbe(config: ConnectionConfig): Promise<ConnectionTest> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993 || config.tls === true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    connectionTimeout: 15_000,
  })

  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const unseen = await client.search({ seen: false })
      return { ok: true, unseen: Array.isArray(unseen) ? unseen.length : 0 }
    } finally {
      lock.release()
    }
  } catch (err) {
    return { ok: false, error: describeImapError(err) }
  } finally {
    await client.logout().catch(() => undefined)
  }
}

/** Test a raw connection config without persisting anything (test-before-add). */
export async function testConnectionConfig(config: ConnectionConfig): Promise<ConnectionTest> {
  return connectAndProbe(config)
}

/** Connect to the channel's mailbox and report connectivity + unseen count. */
export async function testChannelConnection(channel: ChannelRow, emailKey: string): Promise<ConnectionTest> {
  const pass = decryptChannelPassword(channel, emailKey)
  return connectAndProbe({
    host: channel.imapHost,
    port: channel.imapPort,
    user: channel.imapUser,
    pass,
    tls: channel.imapTls,
  })
}

/** Poll a single channel's inbox; every message routes to the channel's tenant. */
export async function pollChannel(pool: DbPool, channel: ChannelRow, emailKey: string): Promise<{
  processed: number
  created: number
  replied: number
  duplicates: number
  errors: number
}> {
  const pass = decryptChannelPassword(channel, emailKey)
  const client = new ImapFlow({
    host: channel.imapHost,
    port: channel.imapPort,
    secure: channel.imapPort === 993 || channel.imapTls,
    auth: { user: channel.imapUser, pass },
    logger: false,
  })

  const result = { processed: 0, created: 0, replied: 0, duplicates: 0, errors: 0 }

  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const uids = await client.search({ seen: false })
      if (!uids || uids.length === 0) return result

      for (const uid of uids) {
        const raw = await client.fetchOne(uid, { source: true, envelope: true })
        if (!raw || !raw.source) continue

        try {
          const res = await processRawEmail(pool, raw.source.toString('utf8'), { tenantId: channel.tenantId })
          result.processed++
          if (res.action === 'created') result.created++
          else if (res.action === 'replied') result.replied++
          else if (res.action === 'duplicate') result.duplicates++
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        } catch {
          result.errors++
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
        }
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout().catch(() => undefined)
  }

  return result
}

/** Enumerate every enabled channel across all tenants (platform-level, no RLS filter). */
export async function listAllEnabledChannels(pool: DbPool): Promise<Array<{ tenantId: string; channels: ChannelRow[] }>> {
  const { rows } = await pool.query('SELECT id FROM tenants')
  const out: Array<{ tenantId: string; channels: ChannelRow[] }> = []
  for (const t of rows as Array<{ id: string }>) {
    const channels = await withTenant(pool, t.id, async (client) => {
      const { rows: ch } = await client.query('SELECT * FROM email_channels WHERE enabled = true')
      return ch as Array<Record<string, unknown>>
    })
    if (channels.length > 0) {
      out.push({ tenantId: t.id, channels: channels.map((c) => rowToChannel(c)) })
    }
  }
  return out
}