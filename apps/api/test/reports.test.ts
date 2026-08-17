import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { withTenant } from '../src/db/pool.js'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('reports', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Reports Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  const create = async (subject: string, priority = 'p3') => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject, priority },
    })
    expect(res.statusCode).toBe(201)
    return res.json().ticket
  }

  it('aggregates ticket metrics', async () => {
    const t1 = await create('Report ticket one', 'p1')
    const t2 = await create('Report ticket two', 'p2')
    await create('Report ticket three', 'p3')

    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${t1.id}/reply`,
      headers: authHeaders(analyst),
      payload: { body: 'On it', visibility: 'public' },
    })
    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${t2.id}/status`,
      headers: authHeaders(owner),
      payload: { status: 'resolved' },
    })

    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/tickets', headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    const report = res.json()

    expect(report.totals.total).toBeGreaterThanOrEqual(3)
    expect(report.totals.resolved).toBeGreaterThanOrEqual(1)
    expect(report.byStatus.find((r: { status: string }) => r.status === 'resolved')).toBeTruthy()
    expect(report.byPriority.find((r: { priority: string }) => r.priority === 'p1')).toBeTruthy()
    expect(report.resolution.n).toBeGreaterThanOrEqual(1)
    expect(report.firstResponse.n).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(report.createdDaily)).toBe(true)
  })

  it('reports workload by assignee', async () => {
    const t = await create('Assign for workload')
    await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${t.id}/assign`,
      headers: authHeaders(owner),
      payload: { assigneeId: analyst.userId },
    })
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/tickets', headers: authHeaders(owner) })
    const row = res.json().byAssignee.find((r: { id: string }) => r.id === analyst.userId)
    expect(row).toBeTruthy()
    expect(row.open_tickets).toBeGreaterThanOrEqual(1)
  })

  it('denies end_user access to reports', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/tickets', headers: authHeaders(endUser) })
    expect(res.statusCode).toBe(403)
  })

  it('breach counts reflect SLA breaches', async () => {
    const t = await create('Will breach for report')
    await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(
        `UPDATE tickets SET due_resolution_at = now() - interval '1 minute' WHERE id = $1`,
        [t.id],
      ),
    )
    const { checkAllBreaches } = await import('../src/modules/tickets/sla.js')
    await checkAllBreaches(app.db)

    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/tickets', headers: authHeaders(owner) })
    expect(res.json().totals.breached).toBeGreaterThanOrEqual(1)
  })
})
