import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { PaystackGateway } from './paystack.js'
import { StripeGateway } from './stripe.js'
import {
  availableGateways, convertUsdCents, countryOptions, gatewayForCountry,
  type GatewayMap,
} from './gateway.js'
import {
  listPlans, getSubscription, createSubscription, changePlan, cancelSubscription,
  listInvoices, listPaymentMethods, addPaymentMethod, removePaymentMethod, setDefaultPaymentMethod,
  createCheckoutInvoice, confirmGatewayCheckout, activateManualSubscription,
  getBillingSettings, setBillingSettings, makeReference, cancelGatewaySubscription,
} from './billing.service.js'
import { requireEntitlement } from '../../middleware/requireEntitlement.js'
import type { BillingConfig } from '../../config.js'

function buildGateways(config: BillingConfig): GatewayMap {
  return {
    paystack: new PaystackGateway(config.paystackSecretKey),
    stripe: new StripeGateway(config.stripeSecretKey, config.stripeWebhookSecret),
    manual: {
      slug: 'manual',
      label: 'Offline payment',
      enabled: true,
      methods: () => [{ id: 'manual', label: 'Pay by invoice (offline)', description: 'We send an invoice; pay by bank transfer. Ideal for enterprise.' }],
      createCheckout: (_input) => Promise.resolve({ url: '/billing?checkout=manual' }),
      verify: () => Promise.resolve({ paid: true }),
      handleWebhook: () => null,
      cancelSubscription: () => Promise.resolve(),
    },
  }
}

function detectCountry(request: FastifyRequest): string {
  const header = request.headers['cf-ipcountry'] ?? request.headers['x-country-code'] ?? ''
  return String(header).toUpperCase().slice(0, 2)
}

export async function billingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  const gateways = buildGateways(app.config.billing)

  // ── Plans (read-only) ────────────────────────────────────────
  app.get('/billing/plans', async (_req, reply) => {
    const plans = await listPlans(app.db)
    return reply.send({ plans })
  })

  // ── Subscription ─────────────────────────────────────────────
  app.get('/billing/subscription', async (req, reply) => {
    const ctx = req.tenantCtx!
    const subscription = await getSubscription(app.db, ctx.tenantId)
    return reply.send({ subscription })
  })

  app.post('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const body = (req.body ?? {}) as { plan?: string; billing_cycle?: string }
    const cycle = body.billing_cycle === 'annual' ? 'annual' : 'monthly'
    const subscription = await createSubscription(app.db, ctx.tenantId, body.plan || 'free', cycle)
    return reply.code(201).send({ subscription })
  })

  app.patch('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const body = (req.body ?? {}) as { plan?: string }
    if (!body.plan) return reply.code(400).send({ error: { code: 'plan_required', message: 'plan is required' } })
    const subscription = await changePlan(app.db, ctx.tenantId, body.plan)
    if (!subscription) return reply.code(404).send({ error: { code: 'no_subscription', message: 'No active subscription found' } })
    return reply.send({ subscription })
  })

  app.delete('/billing/subscription', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const gatewaySubscriptionId = await cancelGatewaySubscription(app.db, ctx.tenantId)
    if (gatewaySubscriptionId) {
      const sub = (await app.db.query(
        'SELECT gateway FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
        [ctx.tenantId],
      )).rows[0] as { gateway: string } | undefined
      const provider = sub?.gateway ? gateways[sub.gateway as GatewaySlug] : undefined
      try { await provider?.cancelSubscription(gatewaySubscriptionId) } catch (error) { app.log.warn({ error }, 'gateway cancel failed') }
    }
    return reply.send({ ok: true })
  })

  // ── Invoices ─────────────────────────────────────────────────
  app.get('/billing/invoices', async (req, reply) => {
    const ctx = req.tenantCtx!
    const invoices = await listInvoices(app.db, ctx.tenantId)
    return reply.send({ invoices })
  })

  // ── Payment methods (stored gateways + manual) ───────────────
  app.get('/billing/payment-methods', async (req, reply) => {
    const ctx = req.tenantCtx!
    const methods = await listPaymentMethods(app.db, ctx.tenantId)
    return reply.send({ methods })
  })

  app.post('/billing/payment-methods', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const body = (req.body ?? {}) as { brand?: string; last4: string; exp_month?: number; exp_year?: number }
    if (!body.last4) return reply.code(400).send({ error: { code: 'last4_required', message: 'last4 is required' } })
    const method = await addPaymentMethod(app.db, ctx.tenantId, body)
    return reply.code(201).send({ method })
  })

  app.delete('/billing/payment-methods/:id', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const { id } = req.params as { id: string }
    const removed = await removePaymentMethod(app.db, ctx.tenantId, Number(id))
    if (!removed) return reply.code(404).send({ error: { code: 'not_found', message: 'Payment method not found' } })
    return reply.send({ ok: true })
  })

  app.patch('/billing/payment-methods/:id/default', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const { id } = req.params as { id: string }
    const set = await setDefaultPaymentMethod(app.db, ctx.tenantId, Number(id))
    if (!set) return reply.code(404).send({ error: { code: 'not_found', message: 'Payment method not found' } })
    return reply.send({ ok: true })
  })

  // ── Region-aware billing metadata ────────────────────────────
  app.get('/billing/meta', async (req, reply) => {
    const ctx = req.tenantCtx!
    const billing = await getBillingSettings(app.db, ctx.tenantId)
    const detectedCountry = detectCountry(req) || billing.country || 'US'
    const country = billing.country || detectedCountry
    const gateways = availableGateways(country, app.config.billing)
    return reply.send({
      country,
      detectedCountry,
      currency: billing.currency || null,
      gateways,
      countries: countryOptions(),
      paystackPublicKey: app.config.billing.paystackPublicKey,
    })
  })

  app.patch('/billing/meta', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const body = (req.body ?? {}) as { country?: string }
    if (!body.country || !/^[A-Za-z]{2}$/.test(body.country)) {
      return reply.code(400).send({ error: { code: 'invalid_country', message: 'Select a valid two-letter country code' } })
    }
    const billing = await setBillingSettings(app.db, ctx.tenantId, { country: body.country })
    return reply.send({ billing, gateways: availableGateways(billing.country, app.config.billing) })
  })

  // ── Checkout (hosted gateway) ────────────────────────────────
  app.post('/billing/checkout', { preHandler: requirePermission('billing.manage') }, async (req, reply) => {
    const ctx = req.tenantCtx!
    const body = (req.body ?? {}) as { plan?: string; billing_cycle?: string }
    const cycle = body.billing_cycle === 'annual' ? 'annual' : 'monthly'
    const plans = await listPlans(app.db)
    const plan = plans.find((p) => p.slug === body.plan)
    if (!plan) return reply.code(404).send({ error: { code: 'plan_not_found', message: 'Plan not found' } })

    const billing = await getBillingSettings(app.db, ctx.tenantId)
    const country = billing.country || detectCountry(req) || 'US'
    const gatewaySlug = gatewayForCountry(country, app.config.billing)
    const gateway = gateways[gatewaySlug]
    if (!gateway.enabled) {
      return reply.code(503).send({ error: { code: 'gateway_unavailable', message: 'No payment gateway is configured for this region yet. Use offline payment.' } })
    }

    const { amountCents, currency } = convertUsdCents(
      cycle === 'annual' ? plan.price_annual_cents : plan.price_monthly_cents,
      country,
    )
    const reference = makeReference()
    await createCheckoutInvoice(app.db, ctx.tenantId, {
      planName: plan.name, planSlug: plan.slug, billingCycle: cycle,
      gateway: gatewaySlug, reference, amountCents, currency,
    })

    const tenant = (await app.db.query('SELECT name FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0] as { name: string } | undefined
    const callbackBase = `${app.config.publicUrl.replace(/\/$/, '')}/billing?checkout=${gatewaySlug}&reference=${reference}`
    const checkout = await gateway.createCheckout({
      tenantId: ctx.tenantId,
      tenantName: tenant?.name ?? 'Your organization',
      email: req.user!.email,
      planSlug: plan.slug,
      planName: plan.name,
      amountCents,
      currency,
      billingCycle: cycle,
      country,
      reference,
      callbackUrl: callbackBase,
    })
    // Remember the gateway's checkout id (Stripe session id) so the
    // return-callback can verify the exact checkout instead of guessing.
    if (checkout.checkoutId) {
      await app.db.query('UPDATE invoices SET gateway_external_id = $2 WHERE gateway_reference = $1', [reference, checkout.checkoutId])
    }
    // Offline checkout: activate immediately, keep the invoice open for the
    // bank transfer, and tell the web app not to redirect to a gateway.
    if (gatewaySlug === 'manual') {
      await activateManualSubscription(app.db, ctx.tenantId, plan.slug, cycle)
      return reply.send({ url: checkout.url, reference, gateway: gatewaySlug, country, currency, confirmed: true })
    }
    return reply.send({ url: checkout.url, reference, gateway: gatewaySlug, country, currency })
  })

  // Verify after the customer returns from the hosted checkout.
  app.get('/billing/checkout/status', async (req, reply) => {
    const ctx = req.tenantCtx!
    const reference = String((req.query as { reference?: string }).reference ?? '')
    if (!reference) return reply.code(400).send({ error: { code: 'reference_required', message: 'reference is required' } })
    const row = (await app.db.query('SELECT gateway, gateway_external_id, tenant_id FROM invoices WHERE gateway_reference = $1', [reference])).rows[0] as
      { gateway: string; gateway_external_id: string | null; tenant_id: string } | undefined
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'Checkout not found' } })
    if (row.tenant_id !== ctx.tenantId) return reply.code(403).send({ error: { code: 'forbidden', message: 'Not your checkout' } })

    const gateway = gateways[row.gateway as GatewaySlug] ?? gateways.manual
    // Paystack verifies by transaction reference; Stripe by session id.
    const verify = await gateway.verify(row.gateway_external_id ?? reference)
    if (!verify.paid) return reply.send({ ok: false, status: 'incomplete' })

    await confirmGatewayCheckout(app.db, reference, verify, row.gateway, ctx.tenantId)
    const [subscription, invoices] = await Promise.all([
      getSubscription(app.db, ctx.tenantId),
      listInvoices(app.db, ctx.tenantId),
    ])
    return reply.send({ ok: true, paid: true, subscription, invoices })
  })

  // ── Entitlement info ────────────────────────────────────────
  app.get('/billing/entitlement', async (req, reply) => {
    const ctx = req.tenantCtx!
    const { getEntitlementInfo } = await import('../../middleware/requireEntitlement.js')
    const info = await getEntitlementInfo(app.db, ctx.tenantId)
    return reply.send(info)
  })

  // ── Billing analytics (owner/admin only) ──────────────────────
  app.get('/billing/analytics', { preHandler: requirePermission('billing.manage') }, async (_req, reply) => {
    const { getBillingAnalytics } = await import('./analytics.service.js')
    const analytics = await getBillingAnalytics(app.db)
    return reply.send(analytics)
  })
}

type GatewaySlug = 'paystack' | 'stripe' | 'manual'