import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('compliance dashboards and analytics', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let securityAnalyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Compliance Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    securityAnalyst = await seedActiveMember(app, owner.tenantId!, 'security_analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')

    // Generate audit entries.
    await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(owner), payload: { subject: 'Audit trail ticket', description: 'desc' } })
  })

  afterAll(async () => {
    await app.close()
  })

  it('gates the audit log on audit.read', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const analystDenied = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: authHeaders(analyst) })
    expect(analystDenied.statusCode).toBe(403)

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: authHeaders(securityAnalyst) })
    expect(allowed.statusCode).toBe(200)
  })

  it('lists and filters audit entries with cursor pagination', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/audit', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(list.json().entries.length).toBeGreaterThan(0)

    const filtered = await app.inject({ method: 'GET', url: '/api/v1/audit?action=ticket', headers: authHeaders(owner) })
    expect(filtered.statusCode).toBe(200)
    const actions = (filtered.json().entries as Array<{ action: string }>).map((e) => e.action)
    expect(actions.length).toBeGreaterThan(0)
    for (const a of actions) expect(a.startsWith('ticket')).toBe(true)

    const none = await app.inject({ method: 'GET', url: '/api/v1/audit?action=zzzz', headers: authHeaders(owner) })
    expect(none.json().entries).toEqual([])

    const page1 = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=1', headers: authHeaders(owner) })
    expect(page1.json().entries).toHaveLength(1)
    expect(page1.json().nextCursor).toBeTruthy()
    const page2 = await app.inject({ method: 'GET', url: `/api/v1/audit?limit=1&before=${page1.json().nextCursor}`, headers: authHeaders(owner) })
    expect(page2.json().entries).toHaveLength(1)
    expect(page2.json().entries[0].id).not.toBe(page1.json().entries[0].id)
  })

  it('verifies the hash chain and exports CSV', async () => {
    const verify = await app.inject({ method: 'GET', url: '/api/v1/audit/verify', headers: authHeaders(owner) })
    expect(verify.statusCode).toBe(200)
    expect(verify.json().ok).toBe(true)
    expect(verify.json().total).toBeGreaterThan(0)

    const csv = await app.inject({ method: 'GET', url: '/api/v1/audit/export.csv', headers: authHeaders(owner) })
    expect(csv.statusCode).toBe(200)
    expect(csv.headers['content-type']).toContain('text/csv')
    expect(csv.body.startsWith('"id","created_at"')).toBe(true)
  })

  it('serves analytics to report.read roles', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/reports/analytics', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/analytics', headers: authHeaders(analyst) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.sessions.total).toBe(0)
    expect(body.sessions.byType).toEqual([])
    expect(body.workload).toEqual([])
    expect(body.sla.complianceRate).toBe(100)
  })

  it('serves the compliance summary to audit.read roles only', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/reports/compliance', headers: authHeaders(analyst) })
    expect(denied.statusCode).toBe(403)

    const res = await app.inject({ method: 'GET', url: '/api/v1/reports/compliance', headers: authHeaders(securityAnalyst) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.audit.integrityOk).toBe(true)
    expect(body.audit.total).toBeGreaterThan(0)
    expect(body.jit.total).toBe(0)
    expect(body.recordings.sessions).toBe(0)
  })
})
