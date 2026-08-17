import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

describe('tracing and synthetic attended-session probe', () => {
  let app: FastifyInstance
  let owner: Session

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Probe Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('emits a valid traceparent and trace id on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    expect(res.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/)
  })

  it('honours an inbound traceparent so a request can join an existing trace', async () => {
    const traceId = '0123456789abcdef0123456789abcdef'
    const res = await app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { traceparent: `00-${traceId}-0123456789abcdef-01` },
    })
    expect(res.headers['x-trace-id']).toBe(traceId)
    expect(res.headers.traceparent).toContain(traceId)
  })

  it('runs the attended-session probe without persisting any tenant data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/attended-session',
      headers: authHeaders(owner),
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, check: 'attended_session', joinTokenIssued: true })

    await withTenant(app.db, owner.tenantId!, async (client) => {
      const devices = await client.query("SELECT id FROM devices WHERE name = '[synthetic probe]'")
      expect(devices.rowCount).toBe(0)
      const sessions = await client.query("SELECT id FROM remote_sessions WHERE reason = '[synthetic probe]'")
      expect(sessions.rowCount).toBe(0)
    })

    const metrics = await app.inject({ method: 'GET', url: '/metrics' })
    expect(metrics.body).toContain('deskos_synthetic_probe_checks_total{check="attended_session",outcome="ok"} 1')
  })

  it('rejects the probe without remote.attended + remote.control', async () => {
    const auditor = await seedActiveMember(app, owner.tenantId!, 'auditor')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/probe/attended-session',
      headers: authHeaders(auditor),
      payload: {},
    })
    expect(res.statusCode).toBe(403)
  })
})
