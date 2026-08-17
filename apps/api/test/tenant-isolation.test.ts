import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import pg from 'pg'
import { verifyAuditChain } from '../src/core/audit.js'
import { withTenant } from '../src/db/pool.js'
import { authHeaders, createTestApp, getDatabaseUrl, seedNotification, signupOwner } from './helpers.js'

describe('tenant isolation', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>
  let notifA1: string
  let notifB1: string

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Isolation A' })
    ownerB = await signupOwner(app, { tenantName: 'Isolation B' })
    notifA1 = await seedNotification(app, ownerA.tenantId!, ownerA.userId, 'tenant-a-secret-1')
    await seedNotification(app, ownerA.tenantId!, ownerA.userId, 'tenant-a-secret-2')
    notifB1 = await seedNotification(app, ownerB.tenantId!, ownerB.userId, 'tenant-b-secret-1')
    await seedNotification(app, ownerB.tenantId!, ownerB.userId, 'tenant-b-secret-2')
  })

  afterAll(async () => {
    await app.close()
  })

  it('user only sees their own tenant notifications via API', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: authHeaders(ownerA) })
    expect(res.statusCode).toBe(200)
    const notifications = res.json().notifications as Array<{ id: string; body: string }>
    expect(notifications).toHaveLength(2)
    const ids = notifications.map((n) => n.id)
    expect(ids).toContain(notifA1)
    expect(ids).not.toContain(notifB1)
    for (const n of notifications) expect(n.body).toMatch(/^tenant-a-/)
  })

  it('rejects accessing a tenant the user is not a member of', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/members',
      headers: authHeaders(ownerA, ownerB.tenantSlug),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.denied_reason).toBe('tenant_not_member')
  })

  it('RLS: raw SQL only returns rows for the active tenant', async () => {
    const client = new pg.Client({ connectionString: getDatabaseUrl() })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ownerA.tenantId])
      const a = await client.query('SELECT body FROM notifications')
      await client.query('COMMIT')
      expect(a.rows).toHaveLength(2)
      for (const row of a.rows) expect(row.body).toMatch(/^tenant-a-/)

      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ownerB.tenantId])
      const b = await client.query('SELECT body FROM notifications')
      await client.query('COMMIT')
      expect(b.rows).toHaveLength(2)
      for (const row of b.rows) expect(row.body).toMatch(/^tenant-b-/)

      const none = await client.query('SELECT body FROM notifications')
      expect(none.rows).toHaveLength(0)
    } finally {
      await client.end()
    }
  })

  it('RLS: cross-tenant INSERT is rejected at the database', async () => {
    const client = new pg.Client({ connectionString: getDatabaseUrl() })
    await client.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ownerA.tenantId])
      await expect(
        client.query(
          `INSERT INTO notifications (tenant_id, user_id, kind, body) VALUES ($1, $2, 'x', 'injected')`,
          [ownerB.tenantId, ownerA.userId],
        ),
      ).rejects.toThrow(/row-level security/)
      await client.query('ROLLBACK')
    } finally {
      await client.end()
    }
  })

  it('audit log is hash-chained and tenant-scoped', async () => {
    const result = await withTenant(app.db, ownerA.tenantId!, async (client) => {
      const { rows } = await client.query('SELECT count(*)::int AS n FROM audit_logs')
      const chain = await verifyAuditChain(client, ownerA.tenantId!)
      return { count: rows[0].n as number, chain }
    })
    expect(result.count).toBeGreaterThan(0)
    expect(result.chain.ok).toBe(true)
  })
})
