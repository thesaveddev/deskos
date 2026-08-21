import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('DEX scoring and security posture', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let deviceId: string
  let deviceToken: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'DEX Org' })
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')

    const rotate = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'dex-box', hostname: 'd-host', os: 'windows' },
    })
    deviceId = enrol.json().device.id as string
    deviceToken = enrol.json().deviceToken as string

    await app.inject({
      method: 'POST',
      url: '/api/v1/endpoint-policies',
      headers: authHeaders(owner),
      payload: { name: 'Encryption required', postureChecks: [{ check: 'encryption', expected: true }] },
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('computes a DEX score from metrics and raises a posture alert on non-compliance', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 25, memPct: 40, diskPct: 55 },
    })
    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/inventory',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { hardware: { manufacturer: 'Dell' }, securityPosture: { encryption: false } },
    })

    const dex = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/dex`, headers: authHeaders(owner) })
    expect(dex.statusCode).toBe(200)
    expect(dex.json().score.score).toBeGreaterThan(0)
    expect(dex.json().score.components.health).toBeGreaterThan(0)
    expect(dex.json().postureAlerts).toHaveLength(1)
    expect(dex.json().postureAlerts[0].check_path).toBe('encryption')
    expect(dex.json().history).toHaveLength(1)
    expect(dex.json().history[0].score).toBe(dex.json().score.score)
  })

  it('resolves the posture alert once the device becomes compliant', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/agent/inventory',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { securityPosture: { encryption: true } },
    })

    const dex = await app.inject({ method: 'GET', url: `/api/v1/devices/${deviceId}/dex`, headers: authHeaders(owner) })
    expect(dex.json().postureAlerts).toEqual([])
    expect(dex.json().score.components.posture).toBe(100)
  })

  it('returns fleet aggregates', async () => {
    const fleet = await app.inject({ method: 'GET', url: '/api/v1/dex/fleet', headers: authHeaders(owner) })
    expect(fleet.statusCode).toBe(200)
    expect(fleet.json().devices).toBe(1)
    expect(fleet.json().avg_score).toBeGreaterThan(0)
    expect(fleet.json().openPostureAlerts).toBe(0)
    expect(fleet.json().postureCompliance.percentage).toBe(100)
    expect(fleet.json().postureCompliance.compliantDevices).toBe(1)
    expect(fleet.json().postureChecks).toEqual([])
  })

  it('records application experience, exposes comparisons, and accepts type-specific weights', async () => {
    const metric = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 35, memPct: 45, diskPct: 50, networkLatencyMs: 180, networkPacketLossPct: 4 },
    })
    expect(metric.statusCode).toBe(200)
    const launch = await app.inject({ method: 'POST', url: '/api/v1/agent/dex/events', headers: { authorization: `Bearer ${deviceToken}` }, payload: { applicationName: 'ReyDesk Console', eventType: 'launch', durationMs: 4200, successful: true } })
    const crash = await app.inject({ method: 'POST', url: '/api/v1/agent/dex/events', headers: { authorization: `Bearer ${deviceToken}` }, payload: { applicationName: 'ReyDesk Console', eventType: 'crash', successful: false } })
    expect(launch.statusCode).toBe(200)
    expect(crash.statusCode).toBe(200)

    const policy = await app.inject({ method: 'POST', url: '/api/v1/dex/policies', headers: authHeaders(owner), payload: { name: 'Laptop user-impact weighting', deviceType: 'laptop', weights: { performance: 0.3, availability: 0.2, security: 0.2, user_impact: 0.3 } } })
    expect(policy.statusCode).toBe(201)
    const survey = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/dex/survey`, headers: authHeaders(owner), payload: { rating: 3, comment: 'Applications feel slow.' } })
    expect(survey.statusCode).toBe(200)

    const compare = await app.inject({ method: 'GET', url: '/api/v1/dex/compare?dimension=device_type', headers: authHeaders(owner) })
    expect(compare.statusCode).toBe(200)
    expect(compare.json().comparisons[0].devices).toBe(1)
    const fleet = await app.inject({ method: 'GET', url: '/api/v1/dex/fleet', headers: authHeaders(owner) })
    expect(fleet.json().componentScores).toHaveProperty('performance')
    expect(fleet.json()).toHaveProperty('trends')
    expect(fleet.json()).toHaveProperty('recommendations')
  })

  it('recomputes on demand and enforces RBAC', async () => {
    const recompute = await app.inject({ method: 'POST', url: `/api/v1/devices/${deviceId}/dex/recompute`, headers: authHeaders(owner) })
    expect(recompute.statusCode).toBe(200)
    expect(recompute.json().score).toBeGreaterThan(0)

    const denied = await app.inject({ method: 'GET', url: '/api/v1/dex/fleet', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)
  })
})
