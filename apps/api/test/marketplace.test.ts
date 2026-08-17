import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner, seedActiveMember, authHeaders } from './helpers.js'

describe('Marketplace', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>

  // Second tenant for isolation tests
  let app2: FastifyInstance
  let owner2: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app)
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')

    app2 = await createTestApp()
    owner2 = await signupOwner(app2)
  })

  afterAll(async () => {
    await app?.close()
    await app2?.close()
  })

  const h = (s: { accessToken: string; tenantId?: string }, tenant?: string) =>
    authHeaders(s, tenant ?? s.tenantId)

  // ── RBAC ──

  it('end_user cannot list apps (marketplace.read denied)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps',
      headers: h(endUser),
    })
    expect(res.statusCode).toBe(403)
  })

  it('analyst can list apps', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps',
      headers: h(analyst),
    })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('end_user cannot create apps (marketplace.manage denied)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/apps',
      headers: h(endUser),
      payload: { name: 'Test', slug: 'test-rbac' },
    })
    expect(res.statusCode).toBe(403)
  })

  // ── App registry CRUD ──

  it('owner can create an app', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/apps',
      headers: h(owner),
      payload: { name: 'Slack Integration', slug: 'slack-integration', description: 'Send tickets to Slack', developer: 'DeskOS', version: '1.0.0', capabilities: ['tickets:read', 'tickets:write'] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.slug).toBe('slack-integration')
    expect(body.name).toBe('Slack Integration')
    expect(body.install_count).toBe(0)
  })

  it('duplicate slug returns 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/apps',
      headers: h(owner),
      payload: { name: 'Slack v2', slug: 'slack-integration' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('list apps returns the created app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps',
      headers: h(owner),
    })
    expect(res.statusCode).toBe(200)
    const apps = res.json()
    expect(apps.some((a: any) => a.slug === 'slack-integration')).toBe(true)
  })

  it('get app by slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().slug).toBe('slack-integration')
  })

  it('update app', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
      payload: { description: 'Updated description' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().description).toBe('Updated description')
  })

  it('nonexistent slug returns 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps/nonexistent',
      headers: h(owner),
    })
    expect(res.statusCode).toBe(404)
  })

  // ── Install / uninstall ──

  it('owner can install an app', async () => {
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['slack-integration'])
    const appId = rows[0].id as string

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/installs/${appId}`,
      headers: h(owner),
      payload: { config: { channel: '#tickets' } },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.app_id).toBe(appId)
    expect(body.enabled).toBe(true)
    expect(body.config).toEqual({ channel: '#tickets' })
  })

  it('install_count incremented', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
    })
    expect(res.json().install_count).toBe(1)
  })

  it('duplicate install returns 409', async () => {
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['slack-integration'])
    const appId = rows[0].id as string

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/installs/${appId}`,
      headers: h(owner),
      payload: {},
    })
    expect(res.statusCode).toBe(409)
  })

  it('list installs returns the installed app', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/installs',
      headers: h(owner),
    })
    expect(res.statusCode).toBe(200)
    const installs = res.json()
    expect(installs.length).toBe(1)
    expect(installs[0].app_slug).toBe('slack-integration')
  })

  it('analyst cannot install (marketplace.manage denied)', async () => {
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['slack-integration'])
    const appId = rows[0].id as string

    // First uninstall as owner so analyst can try
    await app.inject({ method: 'DELETE', url: `/api/v1/marketplace/installs/${appId}`, headers: h(owner) })

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/installs/${appId}`,
      headers: h(analyst),
      payload: {},
    })
    expect(res.statusCode).toBe(403)

    // Reinstall for further tests
    await app.inject({ method: 'POST', url: `/api/v1/marketplace/installs/${appId}`, headers: h(owner), payload: {} })
  })

  it('toggle install (disable)', async () => {
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['slack-integration'])
    const appId = rows[0].id as string

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/marketplace/installs/${appId}/toggle`,
      headers: h(owner),
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe(false)
  })

  it('uninstall app', async () => {
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['slack-integration'])
    const appId = rows[0].id as string

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marketplace/installs/${appId}`,
      headers: h(owner),
    })
    expect(res.statusCode).toBe(204)
  })

  it('install_count decremented', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
    })
    expect(res.json().install_count).toBe(0)
  })

  it('uninstall nonexistent returns 404', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000'
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/marketplace/installs/${fakeId}`,
      headers: h(owner),
    })
    expect(res.statusCode).toBe(404)
  })

  // ── Delete app ──

  it('owner can delete app', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
    })
    expect(res.statusCode).toBe(204)

    const check = await app.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps/slack-integration',
      headers: h(owner),
    })
    expect(check.statusCode).toBe(404)
  })

  // ── Tenant isolation ──

  it('tenant isolation: second tenant cannot see first tenant installs', async () => {
    // Create and install in tenant 1
    await app.inject({
      method: 'POST',
      url: '/api/v1/marketplace/apps',
      headers: h(owner),
      payload: { name: 'Isolation Test', slug: 'isolation-test' },
    })
    const { rows } = await app.db.query('SELECT id FROM app_registry WHERE slug = $1', ['isolation-test'])
    const appId = rows[0].id as string

    await app.inject({
      method: 'POST',
      url: `/api/v1/marketplace/installs/${appId}`,
      headers: h(owner),
      payload: {},
    })

    // Tenant 2 installs list should be empty (apps are platform-wide but installs are tenant-scoped)
    const res2 = await app2.inject({
      method: 'GET',
      url: '/api/v1/marketplace/installs',
      headers: h(owner2),
    })
    expect(res2.statusCode).toBe(200)
    expect(res2.json().length).toBe(0)

    // Tenant 2 can see the app in registry (platform-wide)
    const registryRes = await app2.inject({
      method: 'GET',
      url: '/api/v1/marketplace/apps',
      headers: h(owner2),
    })
    expect(registryRes.statusCode).toBe(200)
    expect(registryRes.json().some((a: any) => a.slug === 'isolation-test')).toBe(true)

    // Cleanup
    await app.inject({ method: 'DELETE', url: `/api/v1/marketplace/installs/${appId}`, headers: h(owner) })
    await app.inject({ method: 'DELETE', url: '/api/v1/marketplace/apps/isolation-test', headers: h(owner) })
  })
})
