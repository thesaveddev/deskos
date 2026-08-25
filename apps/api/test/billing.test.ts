import { createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

const PAYSTACK_SECRET = 'sk_test_0123456789abcdef'
const STRIPE_WEBHOOK_SECRET = 'whsec_test_1234567890'

function paystackSignature(payload: unknown, secret = PAYSTACK_SECRET): string {
  return createHmac('sha512', secret).update(JSON.stringify(payload)).digest('hex')
}

function stripeSignature(raw: string, secret = STRIPE_WEBHOOK_SECRET): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const digest = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
  return `t=${timestamp},v1=${digest}`
}

describe('billing gateways', () => {
  let app: FastifyInstance // no gateway keys → manual fallback
  let keyedApp: FastifyInstance // paystack + stripe keys → webhook HMAC + activation
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let keyedOwner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    keyedApp = await createTestApp({
      REYDESK_PAYSTACK_SECRET_KEY: PAYSTACK_SECRET,
      REYDESK_PAYSTACK_PUBLIC_KEY: 'pk_test_public',
      REYDESK_STRIPE_SECRET_KEY: 'sk_test_stripe_123',
      REYDESK_STRIPE_WEBHOOK_SECRET: STRIPE_WEBHOOK_SECRET,
    })
    owner = await signupOwner(app, { tenantName: 'Billing Org' })
    keyedOwner = await signupOwner(keyedApp, { tenantName: 'Billing Keyed Org' })
  })

  afterAll(async () => {
    await app.close()
    await keyedApp.close()
  })

  it('billing meta detects region and exposes the offline fallback when no keys are set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/meta',
      headers: { ...authHeaders(owner), 'x-country-code': 'NG' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.country).toBe('NG')
    expect(body.detectedCountry).toBe('NG')
    expect(body.gateways.map((g: { slug: string }) => g.slug)).toEqual(['manual'])
  })

  it('owner can persist the billing country for the organization', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/billing/meta',
      headers: authHeaders(owner),
      payload: { country: 'US' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().billing.country).toBe('US')
    expect(res.json().billing.currency).toBe('USD')

    const nigeria = await app.inject({
      method: 'PATCH',
      url: '/api/v1/billing/meta',
      headers: authHeaders(owner),
      payload: { country: 'NG' },
    })
    expect(nigeria.statusCode).toBe(200)
    expect(nigeria.json().billing.currency).toBe('NGN')
  })

  it('does not accept manually fabricated payment method metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/payment-methods',
      headers: authHeaders(owner),
      payload: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
    })
    expect(res.statusCode).toBe(410)
    expect(res.json().error.code).toBe('hosted_payment_method_required')
  })

  it('checkout falls back to manual (offline invoice) and activates immediately', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: { ...authHeaders(owner), 'x-country-code': 'NG' },
      payload: { plan: 'starter', billing_cycle: 'monthly' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.gateway).toBe('manual')
    expect(body.reference).toBeTruthy()
    expect(body.url).toContain('/billing?checkout=manual')

    // Offline checkout activates the subscription without a gateway redirect.
    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.json().subscription.plan_slug).toBe('starter')
    expect(sub.json().subscription.status).toBe('active')
    expect(sub.json().subscription.gateway).toBe('manual')

    // The offline invoice stays open (unpaid) for the bank transfer.
    const invoices = await app.inject({ method: 'GET', url: '/api/v1/billing/invoices', headers: authHeaders(owner) })
    expect(invoices.json().invoices[0].status).toBe('open')
  })

  it('rejects Paystack webhooks with a bad signature', async () => {
    const payload = { event: 'charge.success', data: { reference: 'whatever' } }
    const bad = await keyedApp.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/paystack',
      headers: { 'x-paystack-signature': 'deadbeef' },
      payload,
    })
    expect(bad.statusCode).toBe(401)
  })

  it('accepts a valid Paystack webhook and activates the subscription', async () => {
    const reference = 'ref-activate-1'
    // Seed an open checkout invoice for the owner's tenant (RLS-scoped write).
    await app.db.query(
      `INSERT INTO invoices (tenant_id, number, status, amount_cents, currency, description, gateway, gateway_reference, plan_slug, billing_cycle)
       VALUES ($1, 'RD-TEST-1', 'open', 11850000, 'ngn', 'ReyDesk Pro (monthly) subscription', 'paystack', $2, 'pro', 'monthly')`,
      [owner.tenantId, reference],
    )

    const payload = {
      event: 'charge.success',
      data: {
        reference,
        status: 'success',
        metadata: { tenant_id: owner.tenantId, plan_slug: 'pro', billing_cycle: 'monthly', reydesk: true },
        plan: { plan_code: 'PLN_pro_monthly' },
        subscription: { subscription_code: 'SUB_xyz' },
        customer: { customer_code: 'CUS_abc' },
        authorization: {
          authorization_code: 'AUTH_abc',
          channel: 'card',
          card_type: 'visa',
          last4: '4081',
          exp_month: 12,
          exp_year: 2030,
          reusable: true,
        },
      },
    }
    const res = await keyedApp.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/paystack',
      headers: { 'x-paystack-signature': paystackSignature(payload) },
      payload,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().received).toBe(true)

    const sub = await keyedApp.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.json().subscription.plan_slug).toBe('pro')
    expect(sub.json().subscription.gateway).toBe('paystack')
    expect(sub.json().subscription.gateway_subscription_id).toBe('SUB_xyz')

    // The reusable authorization is stored as a payment method.
    const methods = await keyedApp.inject({ method: 'GET', url: '/api/v1/billing/payment-methods', headers: authHeaders(owner) })
    expect(methods.json().methods[0].external_id).toBe('AUTH_abc')
    expect(methods.json().methods[0].last4).toBe('4081')
    expect(methods.json().methods[0].is_default).toBe(true)
  })

  it('rejects Stripe webhooks with a bad signature', async () => {
    const payload = { type: 'checkout.session.completed', data: { object: { id: 'cs_test' } } }
    const raw = JSON.stringify(payload)
    const bad = await keyedApp.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: raw,
    })
    expect(bad.statusCode).toBe(401)
  })

  it('accepts a valid Stripe webhook and maps the event', async () => {
    const payload = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', payment_status: 'paid', subscription: 'sub_abc', customer: 'cus_123', metadata: { tenant_id: owner.tenantId } } } }
    const raw = JSON.stringify(payload)
    const res = await keyedApp.inject({
      method: 'POST',
      url: '/api/v1/billing/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': stripeSignature(raw) },
      payload: raw,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().received).toBe(true)
  })

  it('exposes the configured gateways for a Paystack region when keys exist', async () => {
    // Fresh tenant with no persisted country → header detection applies.
    const res = await keyedApp.inject({
      method: 'GET',
      url: '/api/v1/billing/meta',
      headers: { ...authHeaders(keyedOwner), 'x-country-code': 'NG' },
    })
    expect(res.statusCode).toBe(200)
    const slugs = res.json().gateways.map((g: { slug: string }) => g.slug)
    expect(slugs).toContain('paystack')
    expect(slugs).toContain('manual')
    const paystack = res.json().gateways.find((g: { slug: string }) => g.slug === 'paystack')
    expect(paystack.methods.some((m: { id: string }) => m.id === 'bank_transfer')).toBe(true)
    expect(res.json().paystackPublicKey).toBe('pk_test_public')
  })
})