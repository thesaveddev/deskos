import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, type Session } from './helpers.js'

describe('API Prometheus metrics', () => {
  let app: FastifyInstance
  let owner: Session

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Metrics Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('exposes a text-format metrics endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.body).toContain('reydesk_api_requests_total')
    expect(res.body).toContain('reydesk_api_request_duration_seconds')
    expect(res.body).toContain('reydesk_active_remote_sessions')
    expect(res.body).toContain('reydesk_session_creations_total')
    expect(res.body).toContain('reydesk_postgres_pool_connections')
  })

  it('counts HTTP requests by method and status class', async () => {
    await app.inject({ method: 'GET', url: '/api/v1/meta' })
    const res = await app.inject({ method: 'GET', url: '/metrics' })
    expect(res.body).toMatch(/reydesk_api_requests_total\{method="GET",status_class="2xx"\} \d+/)
  })

  it('increments session creations and reports active sessions', async () => {
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'metrics-box', hostname: 'metrics-host', os: 'windows' },
    })
    const deviceId = enrol.json().device.id as string
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Metrics test' },
    })
    expect(created.statusCode).toBe(201)

    const res = await app.inject({ method: 'GET', url: '/metrics' })
    // Both counters are per-instance and isolated to this app.
    expect(res.body).toContain('reydesk_session_creations_total 1')
    expect(res.body).toContain('reydesk_active_remote_sessions 1')
  })
})
