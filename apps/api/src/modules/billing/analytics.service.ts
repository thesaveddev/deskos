/**
 * Billing analytics — MRR, subscription counts, gateway reconciliation,
 * churn tracking, and revenue forecasting.
 *
 * All functions are read-only and use raw SQL for performance over large
 * subscription bases.
 */

import type { DbPool } from '../../db/pool.js'

export interface MrrSnapshot {
  mrr_cents: number
  arr_cents: number
  active_subscriptions: number
  trial_subscriptions: number
  past_due_subscriptions: number
  canceled_this_month: number
  new_this_month: number
  conversion_rate: number  // active / (active + canceled + past_due)
}

export interface RevenueByGateway {
  gateway: string
  count: number
  revenue_cents: number
  last_payment_at: string | null
}

export interface PlanBreakdown {
  plan_name: string
  plan_slug: string
  count: number
  monthly_revenue_cents: number
  annual_revenue_cents: number
}

export interface MrrTrend {
  month: string
  mrr_cents: number
  new_mrr: number
  churned_mrr: number
  net_mrr: number
}

export interface ChurnEntry {
  tenant_id: string
  tenant_name: string
  plan_name: string
  canceled_at: string
  reason: string | null
  was_active_days: number
}

export interface DunningEntry {
  tenant_id: string
  tenant_name: string
  email: string
  plan_name: string
  past_since: string
  days_past_due: number
  retry_count: number
  next_retry_at: string | null
}

export interface BillingAnalytics {
  snapshot: MrrSnapshot
  by_gateway: RevenueByGateway[]
  by_plan: PlanBreakdown[]
  mrr_trend: MrrTrend[]
  recent_churn: ChurnEntry[]
  dunning_queue: DunningEntry[]
}

/** Full analytics snapshot for the billing admin dashboard. */
export async function getBillingAnalytics(db: DbPool): Promise<BillingAnalytics> {
  const [snapshot, byGateway, byPlan, mrrTrend, recentChurn, dunningQueue] = await Promise.all([
    getMrrSnapshot(db),
    getRevenueByGateway(db),
    getPlanBreakdown(db),
    getMrrTrend(db),
    getRecentChurn(db),
    getDunningQueue(db),
  ])
  return { snapshot, by_gateway: byGateway, by_plan: byPlan, mrr_trend: mrrTrend, recent_churn: recentChurn, dunning_queue: dunningQueue }
}

async function getMrrSnapshot(db: DbPool): Promise<MrrSnapshot> {
  const row = (await db.query(`
    WITH active AS (
      SELECT s.*, p.price_monthly_cents, p.price_annual_cents
        FROM tenant_subscriptions s
        JOIN subscription_plans p ON p.id = s.plan_id
       WHERE s.status IN ('active', 'trialing')
    ),
    counts AS (
      SELECT
        (SELECT count(*)::int FROM tenant_subscriptions WHERE status = 'active') AS active_count,
        (SELECT count(*)::int FROM tenant_subscriptions WHERE status = 'trialing') AS trial_count,
        (SELECT count(*)::int FROM tenant_subscriptions WHERE status = 'past_due') AS past_due_count,
        (SELECT count(*)::int FROM tenant_subscriptions
           WHERE status = 'canceled' AND canceled_at >= date_trunc('month', now())) AS canceled_month,
        (SELECT count(*)::int FROM tenant_subscriptions
           WHERE created_at >= date_trunc('month', now())
             AND status IN ('active', 'trialing')) AS new_month
    )
    SELECT
      COALESCE(SUM(CASE WHEN billing_cycle = 'monthly' THEN price_monthly_cents
                        ELSE price_annual_cents / 12 END), 0)::bigint AS mrr_cents,
      counts.active_count,
      counts.trial_count,
      counts.past_due_count,
      counts.canceled_month,
      counts.new_month
    FROM active, counts
    GROUP BY counts.active_count, counts.trial_count, counts.past_due_count,
             counts.canceled_month, counts.new_month
  `)).rows[0] ?? {}

  const mrr = Number(row.mrr_cents ?? 0)
  const active = Number(row.active_count ?? 0)
  const trial = Number(row.trial_count ?? 0)
  const pastDue = Number(row.past_due_count ?? 0)
  const canceled = Number(row.canceled_month ?? 0)
  const newCount = Number(row.new_month ?? 0)
  const total = active + canceled + pastDue

  return {
    mrr_cents: mrr,
    arr_cents: mrr * 12,
    active_subscriptions: active,
    trial_subscriptions: trial,
    past_due_subscriptions: pastDue,
    canceled_this_month: canceled,
    new_this_month: newCount,
    conversion_rate: total > 0 ? Math.round((active / total) * 100) : 0,
  }
}

async function getRevenueByGateway(db: DbPool): Promise<RevenueByGateway[]> {
  const { rows } = await db.query(`
    SELECT
      gateway,
      count(*)::int AS count,
      COALESCE(sum(amount_cents), 0)::bigint AS revenue_cents,
      max(paid_at) AS last_payment_at
    FROM invoices
    WHERE status = 'paid' AND gateway IS NOT NULL
    GROUP BY gateway
    ORDER BY revenue_cents DESC
  `)
  return rows.map((r) => ({
    gateway: String(r.gateway),
    count: Number(r.count),
    revenue_cents: Number(r.revenue_cents),
    last_payment_at: r.last_payment_at ? String(r.last_payment_at) : null,
  }))
}

async function getPlanBreakdown(db: DbPool): Promise<PlanBreakdown[]> {
  const { rows } = await db.query(`
    SELECT
      p.name AS plan_name,
      p.slug AS plan_slug,
      count(s.id)::int AS count,
      COALESCE(SUM(CASE WHEN s.billing_cycle = 'monthly' THEN p.price_monthly_cents ELSE 0 END), 0)::bigint AS monthly_revenue_cents,
      COALESCE(SUM(CASE WHEN s.billing_cycle = 'annual' THEN p.price_annual_cents ELSE 0 END), 0)::bigint AS annual_revenue_cents
    FROM subscription_plans p
    LEFT JOIN tenant_subscriptions s ON s.plan_id = p.id AND s.status IN ('active', 'trialing')
    GROUP BY p.id, p.name, p.slug
    ORDER BY count DESC
  `)
  return rows.map((r) => ({
    plan_name: String(r.plan_name),
    plan_slug: String(r.plan_slug),
    count: Number(r.count),
    monthly_revenue_cents: Number(r.monthly_revenue_cents),
    annual_revenue_cents: Number(r.annual_revenue_cents),
  }))
}

async function getMrrTrend(db: DbPool): Promise<MrrTrend[]> {
  const { rows } = await db.query(`
    WITH months AS (
      SELECT generate_series(
        date_trunc('month', now() - interval '11 months'),
        date_trunc('month', now()),
        interval '1 month'
      )::date AS month
    ),
    mrr AS (
      SELECT
        date_trunc('month', s.created_at)::date AS month,
        COALESCE(SUM(CASE WHEN s.billing_cycle = 'monthly' THEN p.price_monthly_cents ELSE p.price_annual_cents / 12 END), 0)::bigint AS new_mrr
      FROM tenant_subscriptions s
      JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.status IN ('active', 'trialing') AND s.created_at >= now() - interval '12 months'
      GROUP BY date_trunc('month', s.created_at)
    ),
    churn AS (
      SELECT
        date_trunc('month', s.canceled_at)::date AS month,
        COALESCE(SUM(CASE WHEN s.billing_cycle = 'monthly' THEN p.price_monthly_cents ELSE p.price_annual_cents / 12 END), 0)::bigint AS churned_mrr
      FROM tenant_subscriptions s
      JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.status = 'canceled' AND s.canceled_at >= now() - interval '12 months'
      GROUP BY date_trunc('month', s.canceled_at)
    )
    SELECT
      m.month,
      COALESCE(mrr.new_mrr, 0)::bigint AS new_mrr,
      COALESCE(ch.churned_mrr, 0)::bigint AS churned_mrr,
      (COALESCE(mrr.new_mrr, 0) - COALESCE(ch.churned_mrr, 0))::bigint AS net_mrr
    FROM months m
    LEFT JOIN mrr ON mrr.month = m.month
    LEFT JOIN ch ON ch.month = m.month
    ORDER BY m.month
  `)
  // Compute running MRR
  let running = 0
  return rows.map((r) => {
    running += Number(r.net_mrr)
    return {
      month: String(r.month).slice(0, 7),
      mrr_cents: running,
      new_mrr: Number(r.new_mrr),
      churned_mrr: Number(r.churned_mrr),
      net_mrr: Number(r.net_mrr),
    }
  })
}

async function getRecentChurn(db: DbPool): Promise<ChurnEntry[]> {
  const { rows } = await db.query(`
    SELECT
      s.tenant_id,
      t.name AS tenant_name,
      p.name AS plan_name,
      s.canceled_at,
      s.cancel_reason AS reason,
      EXTRACT(DAY FROM now() - s.created_at)::int AS was_active_days
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    JOIN tenants t ON t.id = s.tenant_id
    WHERE s.status = 'canceled'
    ORDER BY s.canceled_at DESC
    LIMIT 20
  `)
  return rows.map((r) => ({
    tenant_id: String(r.tenant_id),
    tenant_name: String(r.tenant_name),
    plan_name: String(r.plan_name),
    canceled_at: String(r.canceled_at),
    reason: r.reason ? String(r.reason) : null,
    was_active_days: Number(r.was_active_days),
  }))
}

async function getDunningQueue(db: DbPool): Promise<DunningEntry[]> {
  const { rows } = await db.query(`
    SELECT
      s.tenant_id,
      t.name AS tenant_name,
      u.email,
      p.name AS plan_name,
      s.updated_at AS past_since,
      EXTRACT(DAY FROM now() - s.updated_at)::int AS days_past_due,
      COALESCE((s.settings->>'dunning_retry_count')::int, 0) AS retry_count,
      s.settings->>'dunning_next_retry' AS next_retry_at
    FROM tenant_subscriptions s
    JOIN subscription_plans p ON p.id = s.plan_id
    JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN memberships m ON m.tenant_id = s.tenant_id AND m.org_role = 'owner' AND m.status = 'active'
    LEFT JOIN users u ON u.id = m.user_id
    WHERE s.status = 'past_due'
    ORDER BY s.updated_at ASC
  `)
  return rows.map((r) => ({
    tenant_id: String(r.tenant_id),
    tenant_name: String(r.tenant_name),
    email: String(r.email ?? ''),
    plan_name: String(r.plan_name),
    past_since: String(r.past_since),
    days_past_due: Number(r.days_past_due),
    retry_count: Number(r.retry_count),
    next_retry_at: r.next_retry_at ? String(r.next_retry_at) : null,
  }))
}
