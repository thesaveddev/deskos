import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, uniqueEmail, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

describe('plan entitlements', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  const invite = (owner: Session, email: string, orgRole = 'auditor') =>
    app.inject({ method: 'POST', url: '/api/v1/members/invite', headers: authHeaders(owner), payload: { email, orgRole } })

  it('caps Free-tier invitations at three technicians, counting pending invites, then lifts on checkout', async () => {
    const owner = await signupOwner(app)
    const tenantId = owner.tenantId!
    await seedActiveMember(app, tenantId, 'analyst') // owner + analyst = 2 active

    // 2 active + 1 pending = 3 → still allowed.
    const first = await invite(owner, uniqueEmail('seat-a'))
    expect(first.statusCode).toBe(200)

    // Pending invitations count: the fourth seat is refused on Free.
    const second = await invite(owner, uniqueEmail('seat-b'))
    expect(second.statusCode).toBe(403)
    expect(second.json().error.code).toBe('plan_limit_exceeded')

    // Offline starter checkout records seats = active billable members (2).
    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/checkout',
      headers: authHeaders(owner),
      payload: { plan: 'starter', billing_cycle: 'monthly' },
    })
    expect(checkout.statusCode).toBe(200)
    expect(checkout.json().seats).toBe(2)

    // The offline invoice is the per-seat price × seats (US, no FX).
    const planRow = (await app.db.query(`SELECT price_monthly_cents FROM subscription_plans WHERE slug = 'starter'`)).rows[0]
    const invoices = await app.inject({ method: 'GET', url: '/api/v1/billing/invoices', headers: authHeaders(owner) })
    expect(invoices.statusCode).toBe(200)
    expect(invoices.json().invoices[0].amount_cents).toBe(Number(planRow.price_monthly_cents) * 2)
    expect(invoices.json().invoices[0].seats).toBe(2)

    const sub = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(sub.json().subscription.plan_slug).toBe('starter')
    expect(sub.json().subscription.seats).toBe(2)

    // On the paid plan the cap is the plan's (10) — the invite now succeeds.
    const third = await invite(owner, uniqueEmail('seat-c'))
    expect(third.statusCode).toBe(200)

    // Removing an active member shrinks the seat count again.
    const members = (await app.inject({ method: 'GET', url: '/api/v1/members', headers: authHeaders(owner) })).json().members as Array<{ membership_id: string; email: string }>
    const analyst = members.find((m) => m.email.includes('analyst'))
    expect(analyst).toBeTruthy()
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/members/${analyst!.membership_id}`, headers: authHeaders(owner) })
    expect(removed.statusCode, removed.body).toBe(200)

    const afterRemoval = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(afterRemoval.json().subscription.seats).toBe(1)
  })

  it('refuses to activate paid plans without checkout (revenue bypass)', async () => {
    const owner = await signupOwner(app)

    const post = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription',
      headers: authHeaders(owner),
      payload: { plan: 'starter' },
    })
    expect(post.statusCode).toBe(403)
    expect(post.json().error.code).toBe('upgrade_requires_checkout')

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/billing/subscription',
      headers: authHeaders(owner),
      payload: { plan: 'enterprise' },
    })
    expect(patch.statusCode).toBe(403)
    expect(patch.json().error.code).toBe('upgrade_requires_checkout')

    // The Free plan still activates directly (no payment required).
    const free = await app.inject({
      method: 'POST',
      url: '/api/v1/billing/subscription',
      headers: authHeaders(owner),
      payload: { plan: 'free' },
    })
    expect(free.statusCode).toBe(201)
    // createSubscription returns the raw row (no plan join) — read the slug back.
    const fetched = await app.inject({ method: 'GET', url: '/api/v1/billing/subscription', headers: authHeaders(owner) })
    expect(fetched.json().subscription.plan_slug).toBe('free')
  })

  it('caps Free-tier device enrolment at 100 endpoints', async () => {
    const owner = await signupOwner(app)
    const tenantId = owner.tenantId!

    // Fill the fleet to the Free cap.
    await withTenant(app.db, tenantId, (client) =>
      client.query(`INSERT INTO devices (tenant_id, name) SELECT $1, 'cap-' || g FROM generate_series(1, 100) g`, [tenantId]),
    )

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    expect(rotate.statusCode).toBe(201)
    const code = rotate.json().code as string

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/agent/enrol', payload: { token: code, name: 'cap-boundary', hostname: 'cap-boundary' } })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().error.code).toBe('plan_limit_exceeded')

    // One seat freed → enrolment succeeds again (cap boundary, not a hard lock).
    await withTenant(app.db, tenantId, (client) =>
      client.query(`DELETE FROM devices WHERE tenant_id = $1 AND name = 'cap-1'`, [tenantId]),
    )
    const allowed = await app.inject({ method: 'POST', url: '/api/v1/agent/enrol', payload: { token: code, name: 'cap-boundary', hostname: 'cap-boundary' } })
    expect(allowed.statusCode).toBe(201)
  })
})
