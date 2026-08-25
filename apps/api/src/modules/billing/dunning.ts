/**
 * Subscription dunning — automated retry emails and auto-downgrade for
 * past-due subscriptions.
 *
 * Dunning schedule (after initial payment failure):
 *   Day  1: First reminder email
 *   Day  3: Second reminder email
 *   Day  7: Final warning email
 *   Day 14: Downgrade to free plan, revoke access to paid features
 *
 * The scheduler runs every 6 hours and picks up past-due subscriptions
 * that haven't been retried yet.
 */

import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export interface DunningAction {
  type: 'email_sent' | 'downgraded' | 'no_action'
  tenant_id: string
  days_past_due: number
  retry_count: number
  message: string
}

const RETRY_INTERVALS = [1, 3, 7] // days between retries before downgrade
const DOWNGRADE_AFTER_DAYS = 14

/** Run the dunning scheduler — call this on a periodic interval (e.g. 6h). */
export async function runDunningCycle(
  db: DbPool,
  sendDunningEmail: (email: string, tenantName: string, planName: string, day: number) => Promise<void>,
  log: { info: (obj: unknown, msg: string) => void; warn: (obj: unknown, msg: string) => void },
): Promise<DunningAction[]> {
  const actions: DunningAction[] = []

  const pastDue = (await db.query(`
    SELECT s.id, s.tenant_id, s.plan_id, s.updated_at,
           COALESCE(s.settings->>'dunning_retry_count')::int AS retry_count,
           s.settings->>'dunning_next_retry' AS next_retry,
           s.gateway, s.gateway_subscription_id,
           t.name AS tenant_name, p.name AS plan_name, p.slug AS plan_slug,
           u.email
    FROM tenant_subscriptions s
    JOIN tenants t ON t.id = s.tenant_id
    JOIN subscription_plans p ON p.id = s.plan_id
    LEFT JOIN memberships m ON m.tenant_id = s.tenant_id AND m.org_role = 'owner' AND m.status = 'active'
    LEFT JOIN users u ON u.id = m.user_id
    WHERE s.status = 'past_due'
    ORDER BY s.updated_at ASC
  `)).rows

  for (const row of pastDue) {
    const tenantId = String(row.tenant_id)
    const daysPastDue = Math.floor((Date.now() - new Date(row.updated_at).getTime()) / 86_400_000)
    const retryCount = Number(row.retry_count ?? 0)
    const nextRetry = row.next_retry ? new Date(row.next_retry) : null
    const email = String(row.email ?? '')
    const tenantName = String(row.tenant_name)
    const planName = String(row.plan_name)

    // Skip if not yet time for the next retry
    if (nextRetry && nextRetry > new Date()) continue

    if (daysPastDue >= DOWNGRADE_AFTER_DAYS) {
      // Downgrade to free
      await downgradeToFree(db, tenantId, tenantName)
      actions.push({
        type: 'downgraded',
        tenant_id: tenantId,
        days_past_due: daysPastDue,
        retry_count: retryCount,
        message: `Downgraded ${tenantName} to free plan after ${DOWNGRADE_AFTER_DAYS} days past due`,
      })
      log.info({ tenantId, tenantName, daysPastDue }, 'Dunning: subscription downgraded to free')
      continue
    }

    // Send dunning email if we have an address
    if (email) {
      try {
        await sendDunningEmail(email, tenantName, planName, daysPastDue)
        actions.push({
          type: 'email_sent',
          tenant_id: tenantId,
          days_past_due: daysPastDue,
          retry_count: retryCount,
          message: `Dunning email #${retryCount + 1} sent to ${email} for ${tenantName}`,
        })
        log.info({ tenantId, email, retryCount: retryCount + 1 }, 'Dunning: email sent')
      } catch (error) {
        log.warn({ tenantId, error }, 'Dunning: email failed')
      }
    }

    // Find next retry interval
    const nextIntervalDays = RETRY_INTERVALS.find((d) => d > daysPastDue) ?? DOWNGRADE_AFTER_DAYS
    const nextRetryDate = new Date(Date.now() + nextIntervalDays * 86_400_000)

    await withTenant(db, tenantId, async (client) => {
      await client.query(
        `UPDATE tenant_subscriptions
            SET settings = jsonb_set(
              COALESCE(settings, '{}'::jsonb),
              '{dunning_retry_count}',
              to_jsonb($2::int)
            ) || jsonb_build_object('dunning_next_retry', to_jsonb($3::text))
          WHERE id = $1`,
        [row.id, retryCount + 1, nextRetryDate.toISOString()],
      )
    })
  }

  return actions
}

/** Downgrade a past-due subscription to the free plan. */
async function downgradeToFree(db: DbPool, tenantId: string, tenantName: string): Promise<void> {
  const freePlan = (await db.query(
    'SELECT id FROM subscription_plans WHERE slug = $1',
    ['free'],
  )).rows[0]

  await withTenant(db, tenantId, async (client) => {
    // Cancel the current paid subscription
    await client.query(
      `UPDATE tenant_subscriptions
          SET status = 'canceled', canceled_at = now(), cancel_reason = 'dunning_downgrade',
              updated_at = now()
        WHERE tenant_id = $1 AND status = 'past_due'`,
      [tenantId],
    )
    // Create a new free subscription
    if (freePlan) {
      await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_end)
         VALUES ($1, $2, 'active', 'monthly', now() + interval '365 days')`,
        [tenantId, freePlan.id],
      )
    }
  })
  void tenantName
}
