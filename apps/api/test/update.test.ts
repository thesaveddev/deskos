import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

async function enrolDevice(app: FastifyInstance, owner: Session, name: string): Promise<{ deviceId: string; deviceToken: string }> {
  const rotate = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/enrol-token/rotate',
    headers: authHeaders(owner),
  })
  const enrol = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/enrol',
    payload: { token: rotate.json().token, name, hostname: `${name}-host`, os: 'windows' },
  })
  return { deviceId: enrol.json().device.id as string, deviceToken: enrol.json().deviceToken as string }
}

describe('agent update manifest', () => {
  let app: FastifyInstance
  let owner: Session
  let device: { deviceId: string; deviceToken: string }

  beforeAll(async () => {
    app = await createTestApp({
      DESKOS_UPDATE_VERSION: '0.1.1',
      DESKOS_UPDATE_URL: 'https://downloads.example.com/deskos-agent-0.1.1.exe',
      DESKOS_UPDATE_SHA256: 'a'.repeat(64),
      DESKOS_UPDATE_ROLLOUT_PERCENT: '100',
    })
    owner = await signupOwner(app, { tenantName: 'Update Org' })
    device = await enrolDevice(app, owner, 'update-box')
  })

  afterAll(async () => {
    await app.close()
  })

  it('offers the configured update to an eligible device', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/update?version=0.1.0',
      headers: { authorization: `Bearer ${device.deviceToken}` },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      status: 'available',
      update: {
        version: '0.1.1',
        url: 'https://downloads.example.com/deskos-agent-0.1.1.exe',
        sha256: 'a'.repeat(64),
        rolloutPercent: 100,
      },
    })
  })

  it('reports up_to_date when the device is already current', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/update?version=0.1.1',
      headers: { authorization: `Bearer ${device.deviceToken}` },
    })
    expect(res.json()).toEqual({ update: null, status: 'up_to_date' })
  })

  it('defers devices outside the rollout ring', async () => {
    const deferredApp = await createTestApp({
      DESKOS_UPDATE_VERSION: '0.1.1',
      DESKOS_UPDATE_URL: 'https://downloads.example.com/deskos-agent-0.1.1.exe',
      DESKOS_UPDATE_SHA256: 'a'.repeat(64),
      DESKOS_UPDATE_ROLLOUT_PERCENT: '0',
    })
    try {
      const deferredOwner = await signupOwner(deferredApp, { tenantName: 'Deferred Org' })
      const deferred = await enrolDevice(deferredApp, deferredOwner, 'deferred-box')
      const res = await deferredApp.inject({
        method: 'GET',
        url: '/api/v1/agent/update?version=0.1.0',
        headers: { authorization: `Bearer ${deferred.deviceToken}` },
      })
      expect(res.json()).toEqual({ update: null, status: 'rollout_deferred' })
    } finally {
      await deferredApp.close()
    }
  })

  it('reports not_configured when no update channel is set', async () => {
    const bareApp = await createTestApp()
    try {
      const bareOwner = await signupOwner(bareApp, { tenantName: 'Bare Org' })
      const bare = await enrolDevice(bareApp, bareOwner, 'bare-box')
      const res = await bareApp.inject({
        method: 'GET',
        url: '/api/v1/agent/update?version=0.1.0',
        headers: { authorization: `Bearer ${bare.deviceToken}` },
      })
      expect(res.json()).toEqual({ update: null, status: 'not_configured' })
    } finally {
      await bareApp.close()
    }
  })

  it('records update telemetry as an audited agent event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/update/telemetry',
      headers: { authorization: `Bearer ${device.deviceToken}` },
      payload: { fromVersion: '0.1.0', toVersion: '0.1.1', outcome: 'applied' },
    })
    expect(res.statusCode).toBe(204)

    await withTenant(app.db, owner.tenantId!, async (client) => {
      const rows = await client.query(
        "SELECT action, payload FROM audit_logs WHERE actor_type = 'agent' AND action = 'agent.update.applied' ORDER BY id DESC LIMIT 1",
      )
      expect(rows.rowCount).toBe(1)
      expect(rows.rows[0].payload).toMatchObject({ fromVersion: '0.1.0', toVersion: '0.1.1' })
    })
  })
})
