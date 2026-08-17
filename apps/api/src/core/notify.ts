import type { DbClient, DbPool } from '../db/pool.js'
import { withTenant } from '../db/pool.js'

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/** Canonical notification kinds surfaced in the preference UI. */
export const NOTIFICATION_KINDS = [
  'ticket.replied',
  'ticket.requester_replied',
  'ticket.resolved',
  'sla.breached',
  'device.alert',
  'offline',
  'low_disk',
  'session_invite',
  'session.adhoc.claimed',
  'automation',
  'membership.invited',
  'service.approval',
  'service.approval_decided',
  'change.approval',
] as const

export interface NotifyInput {
  userId: string
  kind: string
  body: string
  subjectType?: string
  subjectId?: string
}

export interface PushDispatchInput {
  tenantId: string
  userId: string
  kind: string
  body: string
}

export type PushDispatcher = (input: PushDispatchInput) => Promise<unknown>

/**
 * Injectable fire-and-forget push dispatcher, wired by app.ts to the push
 * module. Push delivery must never fail the notification write, so notify()
 * invokes it without awaiting and swallows errors.
 */
let pushDispatcher: PushDispatcher | null = null

export function setPushDispatcher(dispatcher: PushDispatcher | null): void {
  pushDispatcher = dispatcher
}

/**
 * Insert a notification within an already-open tenant-scoped transaction,
 * honouring the user's per-kind preference: a muted kind (enabled=false) or an
 * empty channel list skips delivery entirely; otherwise the notification is
 * recorded with the requested channels. Returns true when a row was written.
 */
export async function notify(
  client: DbClient,
  tenantId: string,
  input: NotifyInput,
): Promise<boolean> {
  const pref = await client.query(
    `SELECT enabled, channels
       FROM notification_preferences
      WHERE tenant_id = $1 AND user_id = $2 AND kind = $3`,
    [tenantId, input.userId, input.kind],
  )

  let channels: readonly NotificationChannel[] = ['in_app']
  if (pref.rows[0]) {
    if (!pref.rows[0].enabled) return false
    const stored = pref.rows[0].channels
    if (!Array.isArray(stored) || stored.length === 0) return false
    channels = stored.filter((c): c is NotificationChannel => NOTIFICATION_CHANNELS.includes(c as NotificationChannel))
    if (channels.length === 0) return false
  }

  await client.query(
    `INSERT INTO notifications (tenant_id, user_id, kind, subject_type, subject_id, body, channels)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      tenantId,
      input.userId,
      input.kind,
      input.subjectType ?? null,
      input.subjectId ?? null,
      input.body,
      JSON.stringify(channels),
    ],
  )

  // Push mirrors in-app delivery: whenever a row is written for in-app (or an
  // explicit push preference), a subscription check + send happens out-of-band.
  if ((channels.includes('in_app') || channels.includes('push')) && pushDispatcher) {
    const dispatcher = pushDispatcher
    void dispatcher({ tenantId, userId: input.userId, kind: input.kind, body: input.body }).catch(() => {
      /* push delivery is best-effort */
    })
  }
  return true
}

/** Convenience wrapper that opens its own tenant-scoped transaction. */
export async function notifyInTxn(
  pool: DbPool,
  tenantId: string,
  input: NotifyInput,
): Promise<boolean> {
  return withTenant(pool, tenantId, (client) => notify(client, tenantId, input))
}
