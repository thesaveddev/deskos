import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import type { Mailer } from '../email/mailer.js'
import type { EmailQueue } from '../email/email.queue.js'

/**
 * Needs-attention digest email.
 *
 * Individually, overdue KB reviews, upcoming asset expiries, and open device
 * alerts each fire their own notification at the moment they happen — but
 * nobody gets a consolidated view of "everything in my workspace that needs
 * attention today". This sweep sends one branded email per day to each
 * owner/manager with all three sections, so the queue of small issues can't
 * hide behind the per-event notification stream.
 *
 * A per-(tenant, recipient, day) ledger in needs_attention_digests dedupes:
 * at most one digest per recipient per calendar day (UTC). An empty digest
 * claims nothing and sends nothing, so recipients who have nothing to see
 * are never emailed.
 *
 * Recipients: active owners and service_desk_managers — the roles that can
 * act on every item class. Analysts see devices/assets but cannot resolve
 * KB reviews; end users get nothing from this email.
 */

export interface DigestReviewItem {
  title: string
  dueDate: string
}

export interface DigestExpiryItem {
  label: string
  tag: string
  kind: 'warranty' | 'licence'
  dueDate: string
}

export interface DigestAlertItem {
  deviceName: string
  kind: string
  severity: string
  message: string
}

export interface DigestContent {
  reviews: DigestReviewItem[]
  expiries: DigestExpiryItem[]
  alerts: DigestAlertItem[]
}

export interface DigestRecipientResult {
  userId: string
  itemCount: number
}

export interface DigestSweepResult {
  tenants: number
  recipients: number
}

export const DIGEST_ROLES = ['owner', 'service_desk_manager'] as const
/** Item classes surfaced in the digest; empty sections are omitted. */
export const DIGEST_KIND = 'needs_attention'

export function isDigestEmpty(content: DigestContent): boolean {
  return content.reviews.length === 0 && content.expiries.length === 0 && content.alerts.length === 0
}

/** Collect everything needing attention for the current tenant (RLS context). */
export async function collectDigestContent(client: DbClient): Promise<DigestContent> {
  const [reviews, expiries, alerts] = await Promise.all([
    client.query(
      `SELECT a.title, a.review_due_at::date::text AS due_date
         FROM kb_articles a
        WHERE a.status = 'published'
          AND a.review_due_at IS NOT NULL
          AND a.review_due_at <= now()
        ORDER BY a.review_due_at ASC
        LIMIT 10`,
    ),
    client.query(
      `SELECT tag, name, due_date, kind FROM (
         SELECT a.tag, a.name, a.warranty_until::date::text AS due_date, 'warranty'::text AS kind
           FROM assets a
          WHERE a.expiry_emails_muted = false
            AND a.warranty_until IS NOT NULL
            AND a.warranty_until >= CURRENT_DATE
            AND a.warranty_until < CURRENT_DATE + interval '30 days'
         UNION ALL
         SELECT a.tag, a.name, l.expires_at::date::text AS due_date, 'licence'::text AS kind
           FROM licences l
           JOIN assets a ON a.id = l.asset_id
          WHERE a.expiry_emails_muted = false
            AND l.expires_at IS NOT NULL
            AND l.expires_at >= CURRENT_DATE
            AND l.expires_at < CURRENT_DATE + interval '30 days'
       ) e
       ORDER BY e.due_date ASC
       LIMIT 10`,
    ),
    client.query(
      `SELECT d.name AS device_name, al.kind, al.severity, al.message
         FROM device_alerts al
         JOIN devices d ON d.id = al.device_id
        WHERE al.resolved_at IS NULL
        ORDER BY CASE al.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, al.created_at DESC
        LIMIT 10`,
    ),
  ])

  return {
    reviews: reviews.rows.map((r) => ({ title: String(r.title), dueDate: String(r.due_date) })),
    expiries: expiries.rows.map((r) => ({
      tag: String(r.tag),
      label: String(r.name),
      kind: r.kind === 'licence' ? 'licence' as const : 'warranty' as const,
      dueDate: String(r.due_date),
    })),
    alerts: alerts.rows.map((r) => ({
      deviceName: String(r.device_name),
      kind: String(r.kind),
      severity: String(r.severity),
      message: String(r.message),
    })),
  }
}

/**
 * Send the digest for one tenant inside its RLS context. Returns the
 * recipients that were emailed. Public for tests that drive a single tenant.
 */
export async function sendTenantDigest(
  client: DbClient,
  emailQueue: EmailQueue,
  mailer: Mailer,
  publicUrl: string,
): Promise<DigestRecipientResult[]> {
  const tenantRow = (await client.query('SELECT name FROM tenants')).rows[0]
  const tenantName = String(tenantRow?.name ?? 'ReyDesk')

  const content = await collectDigestContent(client)
  if (isDigestEmpty(content)) return []

  const itemCount = content.reviews.length + content.expiries.length + content.alerts.length

  const { rows: recipients } = await client.query(
    `SELECT DISTINCT m.user_id, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.org_role = ANY($1)
        AND m.status = 'active'
        AND u.status = 'active'`,
    [DIGEST_ROLES],
  )

  const today = new Date().toISOString().slice(0, 10)
  const sent: DigestRecipientResult[] = []

  for (const recipient of recipients) {
    const claimed = await client.query(
      `INSERT INTO needs_attention_digests (tenant_id, recipient_id, digest_date, item_count)
       VALUES (current_setting('app.tenant_id', true)::uuid, $1, $2, $3)
       ON CONFLICT (tenant_id, recipient_id, digest_date) DO NOTHING
       RETURNING id`,
      [recipient.user_id, today, itemCount],
    )
    if (!claimed.rows[0]) continue

    try {
      await emailQueue.addAndSend(mailer.buildNeedsAttentionDigestMail({
        to: recipient.email,
        tenantName,
        content,
        digestUrl: `${publicUrl}/`,
      }))
      sent.push({ userId: recipient.user_id, itemCount })
    } catch {
      // Ledger row claimed; the queue retries delivery itself. Do not
      // unclaim — a retried sweep must not double-send.
    }
  }

  return sent
}

/** Sweep every tenant, isolating failures per tenant. */
export async function checkNeedsAttentionDigest(
  pool: DbPool,
  emailQueue: EmailQueue,
  mailer: Mailer,
  publicUrl: string,
): Promise<DigestSweepResult> {
  const { rows: tenants } = await pool.query('SELECT id FROM tenants')
  let recipients = 0
  let tenantCount = 0
  for (const tenant of tenants) {
    try {
      await withTenant(pool, tenant.id, async (client) => {
        const results = await sendTenantDigest(client, emailQueue, mailer, publicUrl)
        if (results.length > 0) tenantCount += 1
        recipients += results.length
      })
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return { tenants: tenantCount, recipients }
}
