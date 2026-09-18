import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import type { Mailer } from '../email/mailer.js'
import type { EmailQueue } from '../email/email.queue.js'

/**
 * Warranty and licence expiry notices.
 *
 * The sweep runs on the device-alert scheduler tick. For every asset whose
 * warranty (or a licence linked to an asset) falls inside the 30-day window,
 * it records an in-app notification for the asset owner and queues one
 * branded email. A per-(kind, asset, due-date) ledger guarantees each due
 * date notifies at most once — extending a date re-arms the notice.
 *
 * Opt-out is a tenant setting: assets.warranty_expiry_emails (default ON).
 */

export const ASSET_EXPIRY_WINDOW_DAYS = 30

export interface ExpiryNoticeResult {
  /** Warranty notices queued this sweep. */
  warranties: number
  /** Licence-expiry notices queued this sweep. */
  licences: number
}

interface DueRow {
  id: string
  owner_id: string | null
  tag: string
  name: string
  due: string
}

async function sweepKind(
  client: Parameters<typeof notify>[0],
  mailer: Mailer,
  kind: 'warranty' | 'licence',
  emailQueue: EmailQueue,
  tenantName: string,
  tenantId: string,
  settingsUrl: string,
): Promise<number> {
  const due = (await client.query(
    `SELECT ${kind === 'warranty'
      ? `a.id, a.owner_id, a.tag, a.name, a.warranty_until::text AS due`
      : `a.id, a.owner_id, a.tag, a.name, l.expires_at::text AS due`}
       FROM ${kind === 'warranty' ? 'assets a' : 'licences l JOIN assets a ON a.id = l.asset_id'}
      WHERE a.tenant_id = $1
        AND ${kind === 'warranty' ? 'a.warranty_until' : 'l.expires_at'} IS NOT NULL
        AND ${kind === 'warranty' ? 'a.warranty_until' : 'l.expires_at'} >= CURRENT_DATE
        AND ${kind === 'warranty' ? 'a.warranty_until' : 'l.expires_at'} < CURRENT_DATE + ($2 || ' days')::interval`,
    [tenantId, ASSET_EXPIRY_WINDOW_DAYS],
  )).rows as DueRow[]

  let sent = 0
  for (const row of due) {
    // Insert-if-absent acts as the cross-run dedupe: only the sweep that wins
    // the unique key sends the notice.
    const claimed = await client.query(
      `INSERT INTO asset_expiry_notices (tenant_id, kind, asset_id, licence_id, due_date)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, kind, asset_id, due_date) DO NOTHING
       RETURNING id`,
      [tenantId, kind, row.id, null, row.due],
    )
    if (!claimed.rows[0]) continue

    sent += 1
    const isWarranty = kind === 'warranty'
    const subjectLabel = isWarranty ? 'Warranty expiring' : 'Licence expiring'
    const body = isWarranty
      ? `Warranty for asset ${row.tag} — ${row.name} expires on ${row.due}.`
      : `A licence linked to asset ${row.tag} — ${row.name} expires on ${row.due}.`

    if (row.owner_id) {
      await notify(client, tenantId, {
        userId: row.owner_id,
        kind: 'asset.warranty_expiry',
        subjectType: 'asset',
        subjectId: row.id,
        body,
      })
    }
    try {
      await emailQueue.addAndSend(mailer.buildAssetExpiryMailCtx({
        to: row.owner_id ?? '',
        tenantName,
        label: subjectLabel,
        body,
        assetTag: row.tag,
        dueDate: row.due,
        settingsUrl,
      }))
    } catch {
      // In-app notification already recorded; email queue failures are
      // retried by the queue itself.
    }
  }
  return sent
}

export async function checkAssetExpiryNotices(
  pool: DbPool,
  emailQueue: EmailQueue,
  mailer: Mailer,
  publicUrl: string,
): Promise<ExpiryNoticeResult> {
  const { rows: tenants } = await pool.query('SELECT id, name FROM tenants')
  const total: ExpiryNoticeResult = { warranties: 0, licences: 0 }
  for (const tenant of tenants) {
    try {
      await withTenant(pool, tenant.id, async (client) => {
        const settings = (await client.query('SELECT settings FROM tenants WHERE id = $1', [tenant.id])).rows[0]?.settings ?? {}
        const assetSettings = (settings as Record<string, unknown>).assets as Record<string, unknown> | undefined
        if (assetSettings?.warranty_expiry_emails === false) return

        const tenantName = String(tenant.name ?? 'your organisation')
        const settingsUrl = `${publicUrl.replace(/\/$/, '')}/settings/notifications`
        total.warranties += await sweepKind(client, mailer, 'warranty', emailQueue, tenantName, tenant.id, settingsUrl)
        total.licences += await sweepKind(client, mailer, 'licence', emailQueue, tenantName, tenant.id, settingsUrl)
      })
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}
