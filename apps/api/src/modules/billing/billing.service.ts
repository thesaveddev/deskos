import { randomBytes } from 'node:crypto'
import { withTenant, type DbPool, type DbClient } from '../../db/pool.js'
import { currencyForCountry, type VerifyResult } from './gateway.js'

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
  gateway?: string
  gateway_method?: string
  external_id?: string
}

export interface BillingSettings {
  country: string
  currency: string
}

function uniqueReference(): string {
  return `reydesk_${randomBytes(8).toString('hex')}`
}

/* ── Gateway checkout records (invoices with status 'open') ── */

export async function createCheckoutInvoice(
  db: DbPool,
  tenantId: string,
  data: {
    planName: string
    planSlug: string
    billingCycle: 'monthly' | 'annual'
    gateway: string
    reference: string
    amountCents: number
    currency: string
  },
): Promise<number> {
  const number = `RD-${Date.now().toString(36).toUpperCase()}`
  const result = await db.query(
    `INSERT INTO invoices (tenant_id, number, status, amount_cents, currency, description, gateway, gateway_reference, plan_slug, billing_cycle)
     VALUES ($1, $2, 'open', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [tenantId, number, data.amountCents, data.currency.toLowerCase(), `ReyDesk ${data.planName} (${data.billingCycle}) subscription`, data.gateway, data.reference, data.planSlug, data.billingCycle],
  )
  return result.rows[0].id
}

/* ── Plans ─────────────────────────────────────────────────── */

export async function listPlans(db: DbPool): Promise<Plan[]> {
  const result = await db.query(
    `SELECT id, slug, name, description, price_monthly_cents, price_annual_cents,
            max_technicians, max_devices, features, is_active
     FROM subscription_plans WHERE is_active = true ORDER BY price_annual_cents ASC`,
  )
  return result.rows.map((r) => ({ ...r, features: typeof r.features === 'string' ? JSON.parse(r.features) : r.features }))
}

/* ── Subscription ──────────────────────────────────────────── */

export async function getSubscription(db: DbPool, tenantId: string): Promise<Subscription | null> {
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
  db: DbPool,
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
  db: DbPool,
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

export async function cancelSubscription(db: DbPool, tenantId: string): Promise<boolean> {
  const result = await db.query(
    `UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND status IN ('active', 'trialing')`,
    [tenantId],
  )
  return (result.rowCount ?? 0) > 0
}

/* ── Invoices ──────────────────────────────────────────────── */

export async function listInvoices(db: DbPool, tenantId: string, limit = 20): Promise<Invoice[]> {
  const result = await db.query(
    `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  )
  return result.rows
}

/* ── Payment methods ───────────────────────────────────────── */

export async function listPaymentMethods(db: DbPool, tenantId: string): Promise<PaymentMethod[]> {
  const result = await db.query(
    `SELECT * FROM payment_methods WHERE tenant_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [tenantId],
  )
  return result.rows
}

export async function removePaymentMethod(
  db: DbPool,
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
  db: DbPool,
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

/* ── Gateway lifecycle (activated by webhooks / verify) ───────────────── */

/** Mark the checkout invoice paid and activate/sync the subscription. */
export async function confirmGatewayCheckout(
  db: DbPool,
  reference: string,
  result: VerifyResult,
  gateway: string,
  tenantIdOverride?: string,
): Promise<{ invoiceId: number; subscriptionId: number; tenantId: string } | null> {
  const pending = (await db.query(
    `SELECT tenant_id, plan_slug, billing_cycle, id, status FROM invoices
      WHERE gateway_reference = $1 OR gateway_external_id = $1 LIMIT 1`,
    [reference],
  )).rows[0] as { tenant_id: string; plan_slug: string | null; billing_cycle: string | null; id: number; status: string } | undefined
  if (!pending) return null
  const tenantId = tenantIdOverride ?? pending.tenant_id
  const planSlug = pending.plan_slug ?? 'starter'
  const billingCycle: 'monthly' | 'annual' = pending.billing_cycle === 'annual' ? 'annual' : 'monthly'

  return withTenant(db, tenantId, async (client) => {
    const plan = (await client.query('SELECT id FROM subscription_plans WHERE slug = $1', [planSlug])).rows[0]
    if (!plan) return null
    if (pending.status !== 'paid') {
      await client.query(
        `UPDATE invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()), gateway = $2 WHERE id = $1`,
        [pending.id, gateway],
      )
    }

    const existing = (await client.query(
      `SELECT id FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0]
    let subscriptionId: number
    if (existing) {
      const res = await client.query(
        `UPDATE tenant_subscriptions
            SET plan_id = $2, billing_cycle = $3, gateway = $4,
                gateway_subscription_id = $5, gateway_customer_id = $6,
                current_period_start = CASE WHEN current_period_start > now() THEN current_period_start ELSE now() END,
                current_period_end = now() + interval '1 day' * CASE WHEN $7 = 'annual' THEN 365 ELSE 30 END,
                status = 'active', canceled_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [existing.id, plan.id, billingCycle, gateway, result.subscriptionId ?? null, result.customerId ?? null, billingCycle],
      )
      subscriptionId = res.rows[0].id
    } else {
      const periodDays = billingCycle === 'annual' ? 365 : 30
      const res = await client.query(
        `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, gateway, gateway_subscription_id, gateway_customer_id, current_period_end)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, now() + interval '1 day' * $7) RETURNING id`,
        [tenantId, plan.id, billingCycle, gateway, result.subscriptionId ?? null, result.customerId ?? null, periodDays],
      )
      subscriptionId = res.rows[0].id
    }
    await client.query('UPDATE invoices SET subscription_id = $2 WHERE id = $1', [pending.id, subscriptionId])

    if (result.method) {
      await upsertGatewayMethod(client, tenantId, gateway, result.method)
    }
    return { invoiceId: pending.id, subscriptionId, tenantId }
  })
}

async function upsertGatewayMethod(
  client: DbClient,
  tenantId: string,
  gateway: string,
  method: NonNullable<VerifyResult['method']>,
): Promise<void> {
  const existing = (await client.query(
    'SELECT id FROM payment_methods WHERE tenant_id = $1 AND external_id = $2',
    [tenantId, method.externalId],
  )).rows[0]
  if (existing) {
    await client.query(
      `UPDATE payment_methods
          SET gateway_method = $2, brand = $3, last4 = $4, exp_month = $5, exp_year = $6
        WHERE id = $1`,
      [existing.id, method.gatewayMethod, method.brand, method.last4, method.expMonth ?? null, method.expYear ?? null],
    )
    return
  }
  const count = (await client.query('SELECT count(*)::int AS n FROM payment_methods WHERE tenant_id = $1', [tenantId])).rows[0].n as number
  await client.query(
    `INSERT INTO payment_methods (tenant_id, type, gateway, gateway_method, brand, last4, exp_month, exp_year, external_id, is_default)
     VALUES ($1, 'card', $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, gateway, method.gatewayMethod, method.brand, method.last4, method.expMonth ?? null, method.expYear ?? null, method.externalId, count === 0],
  )
}

/**
 * Activate/upgrade the local subscription for an offline (manual/invoice)
 * checkout. Unlike gateway confirmations this does not mark an invoice paid —
 * the invoice stays 'open' until the bank transfer is received.
 */
export async function activateManualSubscription(
  db: DbPool,
  tenantId: string,
  planSlug: string,
  billingCycle: 'monthly' | 'annual' = 'monthly',
): Promise<Subscription> {
  return withTenant(db, tenantId, async (client) => {
    const plan = (await client.query('SELECT id FROM subscription_plans WHERE slug = $1', [planSlug])).rows[0]
    if (!plan) throw new Error('Plan not found')
    const periodDays = billingCycle === 'annual' ? 365 : 30
    const existing = (await client.query(
      `SELECT id FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0]
    if (existing) {
      const res = await client.query(
        `UPDATE tenant_subscriptions
            SET plan_id = $2, billing_cycle = $3, gateway = 'manual',
                current_period_end = now() + interval '1 day' * $4,
                status = 'active', canceled_at = NULL, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [existing.id, plan.id, billingCycle, periodDays],
      )
      return res.rows[0]
    }
    const res = await client.query(
      `INSERT INTO tenant_subscriptions (tenant_id, plan_id, status, billing_cycle, gateway, current_period_end)
       VALUES ($1, $2, 'active', $3, 'manual', now() + interval '1 day' * $4) RETURNING *`,
      [tenantId, plan.id, billingCycle, periodDays],
    )
    return res.rows[0]
  })
}

export async function cancelGatewaySubscription(
  db: DbPool,
  tenantId: string,
): Promise<string | null> {
  const sub = (await db.query(
    `SELECT id, gateway, gateway_subscription_id FROM tenant_subscriptions
      WHERE tenant_id = $1 AND status IN ('active', 'trialing') ORDER BY created_at DESC LIMIT 1`,
    [tenantId],
  )).rows[0] as { id: number; gateway: string; gateway_subscription_id: string | null } | undefined
  if (!sub) return null
  if (sub.gateway && sub.gateway !== 'manual' && sub.gateway_subscription_id) {
    return sub.gateway_subscription_id
  }
  await db.query(
    `UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now()
      WHERE id = $1`,
    [sub.id],
  )
  return null
}

export async function markCanceledByGatewaySubscription(
  db: DbPool,
  gatewaySubscriptionId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE tenant_subscriptions SET status = 'canceled', canceled_at = COALESCE(canceled_at, now()), updated_at = now()
      WHERE gateway_subscription_id = $1 AND status IN ('active', 'trialing')`,
    [gatewaySubscriptionId],
  )
  void reason
}

export async function markPaymentFailed(
  db: DbPool,
  gatewaySubscriptionId: string,
): Promise<void> {
  await db.query(
    `UPDATE tenant_subscriptions SET status = 'past_due', updated_at = now()
      WHERE gateway_subscription_id = $1 AND status IN ('active', 'trialing')`,
    [gatewaySubscriptionId],
  )
}

/* ── Billing settings (region) ────────────────────────────── */

export async function getBillingSettings(db: DbPool, tenantId: string): Promise<BillingSettings> {
  const { rows } = await db.query('SELECT settings FROM tenants WHERE id = $1', [tenantId])
  const settings = (rows[0]?.settings ?? {}) as Record<string, unknown>
  const billing = (settings.billing ?? {}) as Record<string, unknown>
  const country = typeof billing.country === 'string' ? billing.country.toUpperCase().slice(0, 2) : ''
  return {
    country,
    currency: typeof billing.currency === 'string' && billing.currency ? billing.currency : country ? currencyForCountry(country) : '',
  }
}

export async function setBillingSettings(db: DbPool, tenantId: string, patch: Partial<BillingSettings>): Promise<BillingSettings> {
  const current = await getBillingSettings(db, tenantId)
  const normalizedCountry = (patch.country ?? current.country).toUpperCase().slice(0, 2)
  const next = {
    ...current,
    ...patch,
    country: normalizedCountry,
    currency: patch.currency || (patch.country ? currencyForCountry(normalizedCountry) : current.currency || currencyForCountry(normalizedCountry)),
  }
  const invoice = await db.query(
    `UPDATE tenants SET settings = settings || $2::jsonb WHERE id = $1`,
    [tenantId, JSON.stringify({ billing: { country: next.country.toUpperCase().slice(0, 2), currency: next.currency || undefined } })],
  )
  void invoice
  return next
}

/** Export used by tests and the checkout route. */
export function makeReference(): string {
  return uniqueReference()
}
