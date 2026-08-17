import { createHmac, randomUUID } from 'node:crypto'
import { AppError } from '../../core/errors.js'
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../core/crypto.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export const WEBHOOK_CHANNELS = ['generic', 'slack', 'teams'] as const
export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number]

export interface CreateEndpointInput {
  name: string
  url: string
  secret?: string
  channel?: WebhookChannel
  events?: string[]
  enabled?: boolean
}

export interface EndpointRow {
  id: string
  tenant_id: string
  name: string
  url: string
  secret_enc: string
  channel: WebhookChannel
  events: string[]
  enabled: boolean
  created_at: Date
  updated_at: Date
}

/** Injectable outbound HTTP POST. Returns the status code; throws on transport error. */
export type WebhookHttp = (url: string, headers: Record<string, string>, body: string) => Promise<number>

async function defaultHttp(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    })
    return res.status
  } finally {
    clearTimeout(timer)
  }
}

export const defaultWebhookHttp: WebhookHttp = defaultHttp

function maskEndpoint(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    channel: row.channel,
    events: row.events,
    enabled: row.enabled,
    hasSecret: (row.secret_enc as string).length > 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function signPayload(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** Format an event into a channel-appropriate outbound JSON body. */
export function formatPayload(channel: WebhookChannel, event: string, payload: Record<string, unknown>): string {
  if (channel === 'slack') {
    return JSON.stringify({
      text: `*DeskOS* — \`${event}\``,
      attachments: [{ color: '#3b82f6', fields: Object.entries(payload).map(([title, value]) => ({ title, value: String(value), short: false })) }],
    })
  }
  if (channel === 'teams') {
    return JSON.stringify({
      '@type': 'MessageCard',
      '@context': 'https://schema.org/extensions',
      summary: `DeskOS ${event}`,
      title: `DeskOS — ${event}`,
      sections: [{ facts: Object.entries(payload).map(([name, value]) => ({ name, value: String(value) })) }],
    })
  }
  return JSON.stringify({ event, ...payload })
}

function eventMatches(subscribed: string, event: string): boolean {
  if (subscribed === '*') return true
  if (subscribed.endsWith('.*')) return event.startsWith(subscribed.slice(0, -1))
  return subscribed === event
}

async function insertDelivery(
  client: import('pg').PoolClient,
  tenantId: string,
  endpointId: string,
  event: string,
  result: { status: string; attempts: number; lastError: string; deliveredAt: Date | null },
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event, status, attempts, last_error, payload, delivered_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [tenantId, endpointId, event, result.status, result.attempts, result.lastError.slice(0, 1000), JSON.stringify(payload), result.deliveredAt],
  )
}

async function deliverOne(
  endpoint: EndpointRow,
  secret: string,
  event: string,
  payload: Record<string, unknown>,
  http: WebhookHttp,
): Promise<{ status: 'sent' | 'failed'; attempts: number; lastError: string; deliveredAt: Date | null; statusCode?: number }> {
  const body = formatPayload(endpoint.channel, event, payload)
  const headers: Record<string, string> = { 'x-deskos-event': event, 'x-deskos-delivery': randomUUID() }
  if (secret) headers['x-deskos-signature'] = `sha256=${signPayload(secret, body)}`

  const maxAttempts = 3
  let lastError = ''
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const status = await http(endpoint.url, headers, body)
      if (status >= 200 && status < 300) {
        return { status: 'sent', attempts: attempt, lastError: '', deliveredAt: new Date() }
      }
      lastError = `HTTP ${status}`
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'delivery failed'
    }
    if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 200 * attempt))
  }
  return { status: 'failed', attempts: maxAttempts, lastError, deliveredAt: null }
}

export async function listEndpoints(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM webhook_endpoints ORDER BY created_at')
    return rows.map((r: Record<string, unknown>) => maskEndpoint(r))
  })
}

export async function createEndpoint(
  pool: DbPool,
  tenantId: string,
  input: CreateEndpointInput,
  key: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO webhook_endpoints (tenant_id, name, url, secret_enc, channel, events, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        tenantId,
        input.name,
        input.url,
        input.secret ? encryptSecret(input.secret, key) : '',
        input.channel ?? 'generic',
        input.events ?? ['*'],
        input.enabled ?? true,
        actorId,
      ],
    )
    return maskEndpoint(rows[0])
  })
}

export async function updateEndpoint(
  pool: DbPool,
  tenantId: string,
  id: string,
  input: Partial<CreateEndpointInput>,
  key: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = (await client.query('SELECT id FROM webhook_endpoints WHERE id = $1', [id])).rows[0]
    if (!existing) throw AppError.notFound('Webhook endpoint not found')
    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }
    if (input.name !== undefined) push('name', input.name)
    if (input.url !== undefined) push('url', input.url)
    if (input.channel !== undefined) push('channel', input.channel)
    if (input.events !== undefined) push('events', input.events)
    if (input.enabled !== undefined) push('enabled', input.enabled)
    if (input.secret !== undefined && input.secret.length > 0) push('secret_enc', encryptSecret(input.secret, key))
    push('updated_at', new Date())
    params.push(id)
    const { rows } = await client.query(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params)
    return maskEndpoint(rows[0])
  })
}

export async function deleteEndpoint(pool: DbPool, tenantId: string, id: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('DELETE FROM webhook_endpoints WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) throw AppError.notFound('Webhook endpoint not found')
  })
}

export async function listDeliveries(pool: DbPool, tenantId: string, endpointId: string, limit = 100): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, event, status, attempts, last_error, created_at, delivered_at
         FROM webhook_deliveries
        WHERE endpoint_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [endpointId, Math.min(limit, 500)],
    )
    return rows
  })
}

/** Deliver a single event to every enabled endpoint subscribed to it, logging each delivery. */
export async function emitWebhookEvent(
  pool: DbPool,
  tenantId: string,
  event: string,
  payload: Record<string, unknown>,
  key: string,
  http: WebhookHttp = defaultWebhookHttp,
): Promise<{ delivered: number; failed: number }> {
  const endpoints = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM webhook_endpoints WHERE enabled = true')
    return rows as EndpointRow[]
  })

  let delivered = 0
  let failed = 0
  const results: Array<{ endpoint: EndpointRow; event: string; payload: Record<string, unknown>; status: string; attempts: number; lastError: string; deliveredAt: Date | null }> = []

  for (const endpoint of endpoints) {
    if (!endpoint.events.some((e) => eventMatches(e, event))) continue
    const secret = endpoint.secret_enc && isEncryptedSecret(endpoint.secret_enc) ? decryptSecret(endpoint.secret_enc, key) : ''
    const result = await deliverOne(endpoint, secret, event, payload, http)
    if (result.status === 'sent') delivered += 1
    else failed += 1
    results.push({ endpoint, event, payload, status: result.status, attempts: result.attempts, lastError: result.lastError, deliveredAt: result.deliveredAt })
  }

  if (results.length > 0) {
    await withTenant(pool, tenantId, async (client) => {
      for (const r of results) {
        await insertDelivery(client, tenantId, r.endpoint.id, r.event, { status: r.status, attempts: r.attempts, lastError: r.lastError, deliveredAt: r.deliveredAt }, r.payload)
      }
    })
  }

  return { delivered, failed }
}

/** Send a formatted test event to one endpoint (records a delivery). */
export async function testEndpoint(
  pool: DbPool,
  tenantId: string,
  id: string,
  key: string,
  http: WebhookHttp = defaultWebhookHttp,
): Promise<{ status: string; attempts: number; statusCode?: number; lastError: string }> {
  const endpoint = await withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM webhook_endpoints WHERE id = $1', [id])
    if (!rows[0]) throw AppError.notFound('Webhook endpoint not found')
    return rows[0] as EndpointRow
  })
  const secret = endpoint.secret_enc && isEncryptedSecret(endpoint.secret_enc) ? decryptSecret(endpoint.secret_enc, key) : ''
  const event = 'webhook.test'
  const payload = { message: 'DeskOS webhook test' }
  const result = await deliverOne(endpoint, secret, event, payload, http)
  await withTenant(pool, tenantId, async (client) => {
    await insertDelivery(client, tenantId, id, event, { status: result.status, attempts: result.attempts, lastError: result.lastError, deliveredAt: result.deliveredAt }, payload)
  })
  return { status: result.status, attempts: result.attempts, statusCode: result.statusCode, lastError: result.lastError }
}
