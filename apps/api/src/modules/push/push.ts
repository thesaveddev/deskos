import { AppError } from '../../core/errors.js'
import { decryptSecret, encryptSecret } from '../../core/crypto.js'
import type { PushConfig } from '../../config.js'
import { withTenant, type DbPool } from '../../db/pool.js'
import { encryptWebPushPayload } from './encrypt.js'
import { b64urlDecode, signVapid } from './vapid.js'

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
  userAgent?: string
}

export interface PushHttpResponse {
  status: number
}

/** Injectable HTTP client so tests can capture deliveries without a push service. */
export type PushHttp = (
  endpoint: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<PushHttpResponse>

const KIND_TITLES: Record<string, string> = {
  'ticket.replied': 'Ticket update',
  'ticket.requester_replied': 'Requester replied',
  'ticket.resolved': 'Ticket resolved',
  'sla.breached': 'SLA breach',
  'device.alert': 'Device alert',
  offline: 'Device offline',
  low_disk: 'Low disk space',
  session_invite: 'Session invite',
  'session.adhoc.claimed': 'Support code claimed',
  automation: 'Automation',
  'membership.invited': 'Membership invited',
  'service.approval': 'Approval needed',
  'service.approval_decided': 'Approval decided',
  'change.approval': 'Change approval',
}

/** Validate + canonicalise a browser subscription before storing it. */
export function validateSubscription(input: PushSubscriptionInput): { endpoint: string; p256dh: Buffer; auth: Buffer } {
  let endpoint: URL
  try {
    endpoint = new URL(input.endpoint)
  } catch {
    throw AppError.badRequest('invalid push endpoint URL', 'invalid_push_endpoint')
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw AppError.badRequest('push endpoint must be http(s)', 'invalid_push_endpoint')
  }
  let p256dh: Buffer
  try {
    p256dh = b64urlDecode(input.p256dh)
  } catch {
    throw AppError.badRequest('p256dh must be base64url', 'invalid_push_key')
  }
  if (p256dh.length !== 65 || p256dh[0] !== 4) {
    throw AppError.badRequest('p256dh must be a base64url uncompressed P-256 point (65 bytes)', 'invalid_push_key')
  }
  let auth: Buffer
  try {
    auth = b64urlDecode(input.auth)
  } catch {
    throw AppError.badRequest('auth must be base64url', 'invalid_push_key')
  }
  if (auth.length !== 16) {
    throw AppError.badRequest('auth must be a base64url 16-byte secret', 'invalid_push_key')
  }
  return { endpoint: endpoint.href, p256dh, auth }
}

export async function saveSubscription(
  pool: DbPool,
  tenantId: string,
  userId: string,
  input: PushSubscriptionInput,
  emailKey: string,
): Promise<Record<string, unknown>> {
  const { endpoint, p256dh, auth } = validateSubscription(input)
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh_enc, auth_enc, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, endpoint)
       DO UPDATE SET p256dh_enc = EXCLUDED.p256dh_enc, auth_enc = EXCLUDED.auth_enc,
                     user_agent = EXCLUDED.user_agent, last_seen_at = now()
       RETURNING id, endpoint, user_agent, created_at`,
      [
        tenantId,
        userId,
        endpoint,
        encryptSecret(p256dh.toString('base64url'), emailKey),
        encryptSecret(auth.toString('base64url'), emailKey),
        input.userAgent ?? null,
      ],
    )
    return rows[0]
  })
}

export async function deleteSubscription(pool: DbPool, tenantId: string, userId: string, id: string): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    const res = await client.query('DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2', [id, userId])
    return (res.rowCount ?? 0) > 0
  })
}

export async function listSubscriptions(pool: DbPool, tenantId: string, userId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, endpoint, user_agent, created_at, last_seen_at
         FROM push_subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    )
    return rows
  })
}

/**
 * Deliver a push notification to every subscription of a user. Fire-and-forget
 * semantics: never throws — each delivery failure is counted, and endpoints the
 * push service reports gone (404/410) are removed so stale rows do not linger.
 */
export async function sendPushToUser(
  pool: DbPool,
  config: PushConfig,
  tenantId: string,
  userId: string,
  kind: string,
  body: string,
  emailKey: string,
  http: PushHttp,
): Promise<{ delivered: number; removed: number }> {
  if (!config.enabled) return { delivered: 0, removed: 0 }
  const title = KIND_TITLES[kind] ?? 'DeskOS'
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      'SELECT id, endpoint, p256dh_enc, auth_enc FROM push_subscriptions WHERE user_id = $1',
      [userId],
    )
    let delivered = 0
    let removed = 0
    for (const row of rows) {
      let p256dh: Buffer
      let auth: Buffer
      try {
        p256dh = Buffer.from(decryptSecret(row.p256dh_enc, emailKey), 'base64url')
        auth = Buffer.from(decryptSecret(row.auth_enc, emailKey), 'base64url')
      } catch {
        removed += 1
        await client.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id])
        continue
      }
      const result = await deliverOne(config, { endpoint: row.endpoint, p256dh, auth }, title, body, http)
      if (result === 'sent') delivered += 1
      if (result === 'gone') {
        removed += 1
        await client.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id])
      }
    }
    return { delivered, removed }
  })
}

async function deliverOne(
  config: PushConfig,
  sub: { endpoint: string; p256dh: Buffer; auth: Buffer },
  title: string,
  body: string,
  http: PushHttp,
): Promise<'sent' | 'gone' | 'error'> {
  try {
    const audience = new URL(sub.endpoint).origin
    const { token } = signVapid(config, audience)
    const payload = encryptWebPushPayload(Buffer.from(JSON.stringify({ title, body }), 'utf8'), sub.p256dh, sub.auth)
    const res = await http(sub.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(config.ttlSec),
        authorization: `vapid t=${token},k=${config.publicKey}`,
      },
      body: payload,
    })
    if (res.status === 404 || res.status === 410) return 'gone'
    if (res.status >= 200 && res.status < 300) return 'sent'
    return 'error'
  } catch {
    return 'error'
  }
}