import type { DbClient, DbPool } from '../db/pool.js'
import { withTenant } from '../db/pool.js'

export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'push'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

/** Canonical notification kinds surfaced in the preference UI. */
export const NOTIFICATION_KINDS = [
  'ticket.replied',
  'ticket.requester_replied',
  'ticket.ai_triage',
  'ticket.lock_release_requested',
  'ticket.resolved',
  'ticket.rated',
  'ticket.reminder',
  'sla.breached',
  'device.alert',
  'offline',
  'low_disk',
  'session_invite',
  'session.consent_required',
  'session.adhoc.claimed',
  'automation',
  'ai_worker.approval',
  'membership.invited',
  'service.approval',
  'service.approval_decided',
  'change.approval',
  'telephony.call_received',
  'chat.message',
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

export interface EmailDispatchInput {
  tenantId: string
  userId: string
  kind: string
  body: string
  subjectType?: string
  subjectId?: string
}

export interface RealtimeNotification {
  id: string
  tenantId: string
  userId: string
  kind: string
  subjectType: string | null
  subjectId: string | null
  body: string
  createdAt: string
}

const NOTIFICATION_REALTIME_CHANNEL = 'reydesk_notifications'
const notificationSubscribers = new Map<string, Set<(notification: RealtimeNotification) => void>>()

export function subscribeNotifications(
  tenantId: string,
  userId: string,
  listener: (notification: RealtimeNotification) => void,
): () => void {
  const key = `${tenantId}:${userId}`
  const listeners = notificationSubscribers.get(key) ?? new Set()
  listeners.add(listener)
  notificationSubscribers.set(key, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) notificationSubscribers.delete(key)
  }
}

export function publishNotification(notification: RealtimeNotification): void {
  const listeners = notificationSubscribers.get(`${notification.tenantId}:${notification.userId}`)
  if (!listeners) return
  for (const listener of listeners) listener(notification)
}

export type PushDispatcher = (input: PushDispatchInput) => Promise<unknown>
export type EmailDispatcher = (input: EmailDispatchInput) => Promise<unknown>

/**
 * Injectable fire-and-forget push dispatcher, wired by app.ts to the push
 * module. Push delivery must never fail the notification write, so notify()
 * invokes it without awaiting and swallows errors.
 */
let pushDispatcher: PushDispatcher | null = null
let emailDispatcher: EmailDispatcher | null = null

export function setPushDispatcher(dispatcher: PushDispatcher | null): void {
  pushDispatcher = dispatcher
}

export function setEmailDispatcher(dispatcher: EmailDispatcher | null): void {
  emailDispatcher = dispatcher
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

  // Invitations must reach people who have not signed in yet. Other
  // notifications remain in-app by default until the user opts into email.
  // Invitation mail is dispatched by the membership workflow with a
  // single-use join URL. Keep the notification row in-app only here so a
  // preference cannot cause a duplicate, link-less invitation email.
  let channels: readonly NotificationChannel[] = ['in_app']
  if (pref.rows[0]) {
    if (!pref.rows[0].enabled) return false
    const stored = pref.rows[0].channels
    if (!Array.isArray(stored) || stored.length === 0) return false
    channels = stored.filter((c): c is NotificationChannel => NOTIFICATION_CHANNELS.includes(c as NotificationChannel))
    if (channels.length === 0) return false
  }
  if (input.kind === 'membership.invited') channels = channels.filter((channel) => channel !== 'email')
  if (channels.length === 0) return false

  const inserted = await client.query<{
    id: string
    kind: string
    subject_type: string | null
    subject_id: string | null
    body: string
    created_at: string
  }>(
    `INSERT INTO notifications (tenant_id, user_id, kind, subject_type, subject_id, body, channels)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING id, kind, subject_type, subject_id, body, created_at`,
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
  const row = inserted.rows[0]
  if (row) {
    // PostgreSQL emits this only after the surrounding transaction commits,
    // allowing every API node to fan the event out to its connected browsers.
    await client.query('SELECT pg_notify($1, $2)', [NOTIFICATION_REALTIME_CHANNEL, JSON.stringify({
      id: row.id,
      tenantId,
      userId: input.userId,
      kind: row.kind,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      body: row.body,
      createdAt: row.created_at,
    } satisfies RealtimeNotification)])
  }

  // Push mirrors in-app delivery: whenever a row is written for in-app (or an
  // explicit push preference), a subscription check + send happens out-of-band.
  const dispatchInput = {
    tenantId,
    userId: input.userId,
    kind: input.kind,
    body: input.body,
    ...(input.subjectType ? { subjectType: input.subjectType } : {}),
    ...(input.subjectId ? { subjectId: input.subjectId } : {}),
  }
  if ((channels.includes('in_app') || channels.includes('push')) && pushDispatcher) {
    const dispatcher = pushDispatcher
    void dispatcher(dispatchInput).catch(() => {
      /* push delivery is best-effort */
    })
  }
  if (channels.includes('email') && emailDispatcher) {
    const dispatcher = emailDispatcher
    void dispatcher(dispatchInput).catch(() => {
      /* email delivery is queued/best-effort and must not fail the write */
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
