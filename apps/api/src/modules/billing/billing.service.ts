import type { PostgresClient } from '../../db/pool.js'

export interface Plan {
  id: number
  slug: string
  name: string
  description: string
  price_monthly_cents: number
  price_annual_cents: number
  max_technicians: number
  max_devices: number
  features: string[]
  is_active: boolean
}

export interface Subscription {
  id: number
  tenant_id: string
  plan_id: number
  plan_name?: string
  plan_slug?: string
  status: string
  billing_cycle: string
  trial_ends_at: string | null
  current_period_start: string
  current_period_end: string
  canceled_at: string | null
  created_at: string
}

export interface Invoice {
  id: number
  tenant_id: string
  subscription_id: number | null
  number: string
  status: string
  amount_cents: number
  currency: string
  description: string
  due_date: string | null
  paid_at: string | null
  created_at: string
}

export interface PaymentMethod {
  id: number
  tenant_id: string
  type: string
  brand: string
  last4: string
  exp_month: number | null
  exp_year: number | null
  is_default: boolean
  created_at: string
}

/* ── Plans ─────────────────────────────────────────────────── */

export async function listPlans(db: PostgresClient): Promise<Plan[]> {
  const result = await db.query(
    `SELECT id, slug, name, description, price_monthly_cents, price_annual_cents,
            max_technicians, max_devices, features, is_active
     FROM subscription_plans WHERE is_active = true ORDER BY price_annual_cents ASC`,
  )
  return result.rows.map((r) => ({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features }))
}

/* ── Subscription ──────────────────────────────────────────── */

export async function getSubscription(db: PostgresClient, tenantId: string): Promise<Subscription | null> {
  const result = await db.query(
    `SELECT s.*, p.name AS plan_name, p.slug AS plan_slug
     FROM tenant_subscriptions s
     JOIN subscription_plans p ON p.id = s.plan_id
     WHERE s.tenant_id = $1 AND s.status IN ('active', 'trialing')
     ORDER BY s.created_at DESC LIMIT 1`,
    [tenantId],
  )
  return result.rows[0] ?? null
}

export async function createSubscription(
  db: PostgresClient,
  tenantId: string,
  planSlug: string,
  billingCycle: 'monthly' | 'annual' = 'monthly',
): Promise<Subscription> {
  const plan = await db.query('SELECT id FROM subscription_plans WHERE slug = $1', [planSlug])
  if (!plan.rows[0]) throw new Error('Plan not found')

  const periodDays = billingCycle === 'annual' ? 365 : 30
  const result = await db.query(
    `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, current_period_end)
     VALUES ($1, $2, 'active', $3, now() + interval '1 day' * $4)
     RETURNING *`,
    [tenantId, plan.rows[0].id, billingCycle, periodDays],
  )
  return result.rows[0]
}

export async function changePlan(
  db: PostgresClient,
  tenantId: string,
  planSlug: string,
): Promise<Subscription | null> {
  const plan = await db.query('SELECT id FROM subscription_plans WHERE slug = $1', [planSlug])
  if (!plan.rows[0]) return null

  const result = await db.query(
    `UPDATE tenant_subscriptions SET plan_id = $3, updated_at = now()
     WHERE tenant_id = $1 AND status IN ('active', 'trialing')
     RETURNING *`,
    [tenantId, plan.rows[0].id],
  )
  return result.rows[0] ?? null
}

export async function cancelSubscription(db: PostgresClient, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND status IN ('active', 'trialing')`,
    [tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

/* ── Invoices ──────────────────────────────────────────────── */

export async function listInvoices(db: PostgresClient, tenantId: string, limit = 20): Promise<Invoice[]> {
  const result = await db.query(
    `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  )
  return result.rows
}

/* ── Payment methods ───────────────────────────────────────── */

export async function listPaymentMethods(db: PostgresClient, tenantId: string): Promise<PaymentMethod[]> {
  const result = await db.query(
    `SELECT * FROM payment_methods WHERE tenant_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [tenantId],
  )
  return result.rows
}

export async function addPaymentMethod(
  db: PostgresClient,
  tenantId: string,
  data: { type?: string; brand?: string; last4: string; exp_month?: number; exp_year?: number },
): Promise<PaymentMethod> {
  // If first card, make it default
  const existing = await db.query('SELECT id FROM payment_methods WHERE tenant_id = $1', [tenantId])
  const isDefault = existing.rows.length === 0

  const result = await db.query(
    `INSERT INTO payment_methods (tenant_id, type, brand, last4, exp_month, exp_year, is_default)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, data.type || 'card', data.brand || '', data.last4, data.exp_month || null, data.exp_year || null, isDefault],
  )
  return result.rows[0]
}

export async function removePaymentMethod(
  db: PostgresClient,
  tenantId: string,
  methodId: number,
): Promise<boolean> {
  const result = await db.query(
    'DELETE FROM payment_methods WHERE id = $1 AND tenant_id = $2',
    [methodId, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

export async function setDefaultPaymentMethod(
  db: PostgresClient,
  tenantId: string,
  methodId: number,
): Promise<boolean> {
  await db.query(
    'UPDATE payment_methods SET is_default = false WHERE tenant_id = $1',
    [tenantId],
  )
  const result = await db.query(
    'UPDATE payment_methods SET is_default = true WHERE id = $1 AND tenant_id = $2',
    [methodId, tenantId],
  )
  return (result.rowCount ?? 0) > 0
}
