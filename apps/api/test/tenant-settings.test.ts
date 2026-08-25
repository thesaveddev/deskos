import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner, seedActiveMember, authHeaders } from './helpers.js'

describe('tenant settings', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Settings A' })
    ownerB = await signupOwner(app, { tenantName: 'Settings B' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('reads tenant basic settings', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.tenant.name).toBe('Settings A')
    expect(body.tenant.slug).toBe(ownerA.tenantSlug)
    expect(body.membership.orgRole).toBe('owner')
  })

  it('updates tenant name, slug, and region', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { name: 'Settings A Renamed', slug: `${ownerA.tenantSlug}-v2`, region: 'eu-west' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body.tenant.name).toBe('Settings A Renamed')
    expect(body.tenant.slug).toBe(`${ownerA.tenantSlug}-v2`)
    expect(body.tenant.region).toBe('eu-west')

    const again = await app.inject({ method: 'GET', url: '/api/v1/tenant', headers: authHeaders(ownerA) })
    expect(again.json().tenant.name).toBe('Settings A Renamed')
  })

  it('rejects a slug already used by another tenant', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { slug: ownerB.tenantSlug },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('slug_taken')
  })

  it('rejects invalid slugs and empty names', async () => {
    const badSlug = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { slug: 'Bad Slug!' },
    })
    expect(badSlug.statusCode).toBe(400)

    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(ownerA),
      payload: { name: '   ' },
    })
    expect(empty.statusCode).toBe(400)
  })

  it('reads merged workspace defaults and persists nested operational settings', async () => {
    const initial = await app.inject({
      method: 'GET',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(ownerA),
    })
    expect(initial.statusCode).toBe(200)
    expect(initial.json().settings.remote_support.require_consent).toBe(true)
    expect(initial.json().settings.endpoints.heartbeat_interval_seconds).toBe(30)

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(ownerA),
      payload: {
        remote_support: { default_expiry_minutes: 45, allow_clipboard: false },
        endpoints: { offline_after_minutes: 20 },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().settings.remote_support.default_expiry_minutes).toBe(45)
    expect(updated.json().settings.remote_support.allow_clipboard).toBe(false)
    expect(updated.json().settings.remote_support.require_consent).toBe(true)
    expect(updated.json().settings.endpoints.offline_after_minutes).toBe(20)
  })

  it('reports MFA enrollment coverage for each organization policy', async () => {
    const optional = await app.inject({ method: 'GET', url: '/api/v1/tenant/mfa-policy', headers: authHeaders(ownerA) })
    expect(optional.statusCode).toBe(200)
    expect(optional.json()).toMatchObject({ mfa_policy: 'optional', users_total: 1, users_with_mfa: 0, users_needing_setup: 0 })

    const required = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/mfa-policy',
      headers: authHeaders(ownerA),
      payload: { mfa_policy: 'required' },
    })
    expect(required.statusCode).toBe(200)
    expect(required.json()).toMatchObject({ mfa_policy: 'required', users_total: 1, users_with_mfa: 0, users_needing_setup: 1 })

    await seedActiveMember(app, ownerA.tenantId!, 'analyst')
    await seedActiveMember(app, ownerA.tenantId!, 'service_desk_manager')
    const adminOnly = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/mfa-policy',
      headers: authHeaders(ownerA),
      payload: { mfa_policy: 'admin_only' },
    })
    expect(adminOnly.statusCode).toBe(200)
    expect(adminOnly.json()).toMatchObject({ users_total: 3, users_with_mfa: 0, users_needing_setup: 2 })

    const readBack = await app.inject({ method: 'GET', url: '/api/v1/tenant/mfa-policy', headers: authHeaders(ownerA) })
    expect(readBack.statusCode).toBe(200)
    expect(readBack.json()).toMatchObject({ mfa_policy: 'admin_only', users_total: 3, users_needing_setup: 2 })
  })

  it('requires settings.manage for workspace setting updates', async () => {
    const analyst = await seedActiveMember(app, ownerA.tenantId!, 'analyst')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant/settings',
      headers: authHeaders(analyst),
      payload: { portal: { enabled: false } },
    })
    expect(res.statusCode).toBe(403)
  })

  it('requires tenant.manage permission', async () => {
    const analyst = await seedActiveMember(app, ownerA.tenantId!, 'analyst')
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/tenant',
      headers: authHeaders(analyst),
      payload: { name: 'Nope' },
    })
    expect(res.statusCode).toBe(403)
  })
})

describe('portal invitations by email', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  const SMTP_ENV = {
    DESKOS_SMTP_HOST: 'smtp.test.local',
    DESKOS_SMTP_PORT: '587',
    DESKOS_SMTP_USER: 'relay-user',
    DESKOS_SMTP_PASS: 'relay-pass',
    DESKOS_SMTP_FROM: 'support@deskos.test',
    DESKOS_SMTP_JSON: 'true',
  }

  beforeAll(async () => {
    app = await createTestApp(SMTP_ENV)
    owner = await signupOwner(app, { tenantName: 'Portal Invites Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('sends a branded invitation email with the portal URL and personal message', async () => {
    const settings = await app.inject({ method: 'GET', url: '/api/v1/tenant/settings', headers: authHeaders(owner) })
    const portalUrl = settings.json().portal.url
    expect(portalUrl).toContain(owner.tenantSlug)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/settings/portal/invite',
      headers: authHeaders(owner),
      payload: {
        to: 'alice@example.com, bob@example.com\ncarol@example.com',
        message: 'Hi team — please set up your portal account.',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, recipients: 3, mailConfigured: true })
    expect(res.json().portalUrl).toBe(portalUrl)

    const invites = app.mailer.sent.filter((mail) => mail.subject.includes('support portal is ready'))
    expect(invites).toHaveLength(3)
    expect(invites.map((mail) => mail.to).sort()).toEqual(['alice@example.com', 'bob@example.com', 'carol@example.com'])
    expect(invites[0].html).toContain(portalUrl)
    expect(invites[0].html).toContain('Hi team — please set up your portal account.')
    expect(invites[0].html).toContain('Open your portal')
    expect(invites[0].text).toContain('Sign in with your work email')
  })

  it('rejects invalid recipients and deduplicates repeated addresses', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/settings/portal/invite',
      headers: authHeaders(owner),
      payload: { to: 'not-an-email' },
    })
    expect(bad.statusCode).toBe(400)

    const before = app.mailer.sent.length
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/settings/portal/invite',
      headers: authHeaders(owner),
      payload: { to: 'alice@example.com, ALICE@example.com' },
    })
    expect(dup.statusCode).toBe(200)
    expect(dup.json().recipients).toBe(1)
    expect(app.mailer.sent.length).toBe(before + 1)
  })

  it('requires settings.manage permission to send invitations', async () => {
    const analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tenant/settings/portal/invite',
      headers: authHeaders(analyst),
      payload: { to: 'nobody@example.com' },
    })
    expect(res.statusCode).toBe(403)
  })
})
