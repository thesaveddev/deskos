import { isIP } from 'node:net'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface ApiAllowlistEntry {
  id: string
  cidr: string
  label: string
  enabled: boolean
  created_at: string
}

export interface ApiSecuritySettings {
  ip_allowlist_enabled: boolean
  allowlist: ApiAllowlistEntry[]
}

export interface ApiUsageEvent {
  tenantId: string
  clientId: string | null
  method: string
  path: string
  statusCode?: number
  sourceIp?: string
  durationMs?: number
}

function parseCidr(cidr: string): { address: bigint; bits: number; prefix: number } | null {
  const parts = cidr.trim().split('/')
  if (parts.length > 2) return null
  const [rawAddress, rawPrefix] = parts
  const version = isIP(rawAddress)
  if (!version) return null
  const bits = version === 4 ? 32 : 128
  const prefix = rawPrefix === undefined ? bits : Number(rawPrefix)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null

  if (version === 4) {
    const parts = rawAddress.split('.').map(Number)
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null
    const address = parts.reduce((value, part) => (value << 8n) | BigInt(part), 0n)
    return { address, bits, prefix }
  }

  const [head, tail = ''] = rawAddress.toLowerCase().split('::')
  const left = head ? head.split(':').filter(Boolean) : []
  const right = tail ? tail.split(':').filter(Boolean) : []
  const missing = 8 - left.length - right.length
  if (missing < 0) return null
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null
  const address = groups.reduce((value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)), 0n)
  return { address, bits, prefix }
}

function addressToBigInt(address: string): { value: bigint; bits: number } | null {
  const version = isIP(address)
  if (!version) return null
  const parsed = parseCidr(address)
  return parsed ? { value: parsed.address, bits: parsed.bits } : null
}

export function isValidCidr(cidr: string): boolean {
  return parseCidr(cidr) !== null
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const network = parseCidr(cidr)
  const candidate = addressToBigInt(ip)
  if (!network || !candidate || candidate.bits !== network.bits) return false
  if (network.prefix === 0) return true
  const shift = BigInt(network.bits - network.prefix)
  const mask = ((1n << BigInt(network.prefix)) - 1n) << shift
  return (candidate.value & mask) === (network.address & mask)
}

export async function getApiSecurity(pool: DbPool, tenantId: string): Promise<ApiSecuritySettings> {
  return withTenant(pool, tenantId, async (client) => {
    const settings = (await client.query(
      `SELECT ip_allowlist_enabled FROM api_security_settings WHERE tenant_id = $1`,
      [tenantId],
    )).rows[0]
    const entries = await client.query(
      `SELECT id, cidr, label, enabled, created_at
         FROM api_ip_allowlist WHERE tenant_id = $1 ORDER BY created_at ASC`,
      [tenantId],
    )
    return {
      ip_allowlist_enabled: Boolean(settings?.ip_allowlist_enabled ?? false),
      allowlist: entries.rows as ApiAllowlistEntry[],
    }
  })
}

export async function updateApiSecurity(
  pool: DbPool,
  tenantId: string,
  actorId: string,
  enabled: boolean,
): Promise<ApiSecuritySettings> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO api_security_settings (tenant_id, ip_allowlist_enabled, updated_by, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id) DO UPDATE SET ip_allowlist_enabled = $2, updated_by = $3, updated_at = now()`,
      [tenantId, enabled, actorId],
    )
  })
  return getApiSecurity(pool, tenantId)
}

export async function addApiAllowlistEntry(
  pool: DbPool,
  tenantId: string,
  actorId: string,
  cidr: string,
  label: string,
): Promise<ApiAllowlistEntry> {
  const normalized = cidr.trim()
  if (!isValidCidr(normalized)) throw new Error('Enter a valid IPv4 or IPv6 address or CIDR range')
  return withTenant(pool, tenantId, async (client) => {
    try {
      const result = await client.query(
        `INSERT INTO api_ip_allowlist (tenant_id, cidr, label, created_by)
         VALUES ($1, $2, $3, $4) RETURNING id, cidr, label, enabled, created_at`,
        [tenantId, normalized, label.trim().slice(0, 120), actorId],
      )
      return result.rows[0] as ApiAllowlistEntry
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new Error('That network is already on the allowlist')
      throw error
    }
  })
}

export async function removeApiAllowlistEntry(pool: DbPool, tenantId: string, id: string): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query('DELETE FROM api_ip_allowlist WHERE id = $1 AND tenant_id = $2', [id, tenantId])
    return (result.rowCount ?? 0) > 0
  })
}

export async function isApiIpAllowed(pool: DbPool, tenantId: string, ip: string): Promise<boolean> {
  const security = await getApiSecurity(pool, tenantId)
  if (!security.ip_allowlist_enabled) return true
  const activeEntries = security.allowlist.filter((entry) => entry.enabled)
  return activeEntries.length > 0 && activeEntries.some((entry) => ipMatchesCidr(ip, entry.cidr))
}

export async function recordApiUsage(pool: DbPool, event: ApiUsageEvent): Promise<void> {
  try {
    await withTenant(pool, event.tenantId, async (client) => {
      await client.query(
        `INSERT INTO api_usage_events (tenant_id, client_id, method, path, status_code, source_ip, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [event.tenantId, event.clientId, event.method, event.path.slice(0, 500), event.statusCode ?? 200, event.sourceIp ?? null, event.durationMs ?? null],
      )
    })
  } catch {
    // Usage telemetry must never break a customer API request.
  }
}

export async function getApiUsage(pool: DbPool, tenantId: string, days = 30): Promise<{
  days: number
  total: number
  errors: number
  byDay: Array<{ day: string; requests: number; errors: number }>
  byClient: Array<{ client_id: string | null; requests: number }>
  byPath: Array<{ path: string; requests: number }>
}> {
  const safeDays = Math.min(90, Math.max(1, Math.floor(days)))
  return withTenant(pool, tenantId, async (client) => {
    const [summary, byDay, byClient, byPath] = await Promise.all([
      client.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status_code >= 400)::int AS errors
           FROM api_usage_events WHERE tenant_id = $1 AND created_at >= now() - ($2::int * interval '1 day')`,
        [tenantId, safeDays],
      ),
      client.query(
        `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                count(*)::int AS requests,
                count(*) FILTER (WHERE status_code >= 400)::int AS errors
           FROM api_usage_events WHERE tenant_id = $1 AND created_at >= now() - ($2::int * interval '1 day')
          GROUP BY 1 ORDER BY 1`,
        [tenantId, safeDays],
      ),
      client.query(
        `SELECT client_id, count(*)::int AS requests
           FROM api_usage_events WHERE tenant_id = $1 AND created_at >= now() - ($2::int * interval '1 day')
          GROUP BY client_id ORDER BY requests DESC LIMIT 10`,
        [tenantId, safeDays],
      ),
      client.query(
        `SELECT path, count(*)::int AS requests
           FROM api_usage_events WHERE tenant_id = $1 AND created_at >= now() - ($2::int * interval '1 day')
          GROUP BY path ORDER BY requests DESC LIMIT 10`,
        [tenantId, safeDays],
      ),
    ])
    return {
      days: safeDays,
      total: Number(summary.rows[0]?.total ?? 0),
      errors: Number(summary.rows[0]?.errors ?? 0),
      byDay: byDay.rows.map((row) => ({ day: String(row.day), requests: Number(row.requests), errors: Number(row.errors) })),
      byClient: byClient.rows.map((row) => ({ client_id: row.client_id ? String(row.client_id) : null, requests: Number(row.requests) })),
      byPath: byPath.rows.map((row) => ({ path: String(row.path), requests: Number(row.requests) })),
    }
  })
}
