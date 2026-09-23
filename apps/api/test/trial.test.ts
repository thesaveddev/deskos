import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, uniqueEmail } from './helpers.js'

describe('14-day Pro trial', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('starts every signup on a trialing Pro subscription, lifts Free caps, then expires back to Free', async () => {
    const owner = await signupOwner(app, { trial: true })
    const tenantId = owner.tenantId!

    // Signup creates the trialing Pro subscription with a future expiry.
    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.statusCode).toBe(200)
    expect(sub.json().subscription).toBeTruthy()
    expect(sub.json().subscription.status).toBe('trialing')
    expect(sub.json().subscription.plan_slug).toBe('pro')
    expect(new Date(sub.json().subscription.trial_ends_at).getTime()).toBeGreaterThan(Date.now())

    // Entitlements resolve to Pro while trialing (Pro = unlimited technicians).
    const ent = await app.inject({ method: 'GET', url: '/api/v1/billing/entitlement', headers: authHeaders(owner) })
    expect(ent.statusCode).toBe(200)
    expect(ent.json().planSlug).toBe('pro')

    // Owner +3 seats =4, which exceeds the Free cap of3 — allowed on trial.
    for (const tag of ['trial-a', 'trial-b', 'trial-c']) {
      const invite = await app.inject({
        method: 'POST',
        url: '/api/v1/members/invite',
        headers: authHeaders(owner),
        payload: { email: uniqueEmail(tag), orgRole: 'auditor' },
      })
      expect(invite.statusCode, invite.body).toBe(200)
    }

    // Run the trial out.
    await app.db.query(
      `UPDATE tenant_subscriptions SET trial_ends_at = now() - interval '1 hour' WHERE tenant_id = $1 AND status = 'trialing'`,
      [tenantId],
    )

    // The next subscription read lazily ends the trial…
    const after = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(after.json().subscription).toBeNull()
    const row = (await app.db.query(
      `SELECT status FROM tenant_subscriptions WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenantId],
    )).rows[0]
    expect(row.status).toBe('canceled')

    // …entitlements fall back to Free…
    const entAfter = await app.inject({ method: 'GET', url: '/api/v1/billing/entitlement', headers: authHeaders(owner) })
    expect(entAfter.json().planSlug).toBe('free')
    expect(entAfter.json().maxTechnicians).toBe(3)

    // …and the fourth seat is refused again.
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/members/invite',
      headers: authHeaders(owner),
      payload: { email: uniqueEmail('trial-d'), orgRole: 'auditor' },
    })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().error.code).toBe('plan_limit_exceeded')
  })

  it('converts a live trial through checkout without tripping the one-live-row unique index', async () => {
    const owner = await signupOwner(app, { trial: true })

    const before = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(before.json().subscription.status).toBe('trialing')

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authHeaders(owner),
      payload: { plan: 'starter', billing_cycle: 'monthly' },
    })
    expect(checkout.statusCode, checkout.body).toBe(200)

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.json().subscription.status).toBe('active')
    expect(sub.json().subscription.plan_slug).toBe('starter')

    const live = (await app.db.query(
      `SELECT count(*)::int AS n FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'trialing')`,
      [owner.tenantId!],
    )).rows[0]
    expect(Number(live.n)).toBe(1)
  })

  it('downgrades a trial to Free through the subscription route without stacking rows', async () => {
    const owner = await signupOwner(app, { trial: true })

    const downgrade = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription',
      headers: authHeaders(owner),
      payload: { plan: 'free', billing_cycle: 'monthly' },
    })
    expect(downgrade.statusCode, downgrade.body).toBe(201)

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.json().subscription.plan_slug).toBe('free')

    const live = (await app.db.query(
      `SELECT count(*)::int AS n FROM tenant_subscriptions WHERE tenant_id = $1 AND status IN ('active', 'trialing')`,
      [owner.tenantId!],
    )).rows[0]
    expect(Number(live.n)).toBe(1)
  })
})
