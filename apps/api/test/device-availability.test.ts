import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { checkDeviceAlertsForTenant } from '../src/modules/devices/alerts.js'

describe('device availability policies', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Availability Org' })
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
    const enrolled = await app.inject({
      method: 'POST', url: '/api/v1/agent/enrol',
      payload: { token: rotated.json().token, name: 'policy-laptop', hostname: 'policy-laptop', deviceType: 'laptop', os: 'windows' },
    })
    expect(enrolled.statusCode).toBe(201)
    deviceId = enrolled.json().device.id
  })

  afterAll(async () => { await app.close() })

  it('supports policy scopes, separate alert/ticket delays, and recovery', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/availability-policies', headers: authHeaders(owner),
      payload: {
        name: 'Laptop availability', deviceType: 'laptop', offlineThresholdMinutes: 5, gracePeriodMinutes: 2,
        alertDelayMinutes: 0, ticketDelayMinutes: 30, ticketMode: 'ticket', timezone: 'Europe/London',
        suppressPowerStates: ['battery'], recoveryNotifications: true,
      },
    })
    expect(created.statusCode).toBe(201)
    const policyId = created.json().policy.id as string

    const list = await app.inject({ method: 'GET', url: '/api/v1/monitoring/availability-policies', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(list.json().policies[0].device_type).toBe('laptop')

    await withTenant(app.db, owner.tenantId!, (client) => client.query(`UPDATE devices SET power_source = 'ac', last_seen_at = now() - interval '20 minutes' WHERE id = $1`, [deviceId]))
    const first = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: 120 })
    expect(first.offline).toBe(1)
    expect(first.tickets).toBe(0)

    const pending = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT id, ticket_id, ticket_due_at FROM device_alerts WHERE device_id = $1 AND availability_policy_id = $2 AND resolved_at IS NULL`, [deviceId, policyId]).then((result) => result.rows[0]))
    expect(pending.ticket_id).toBeNull()
    expect(pending.ticket_due_at).toBeTruthy()

    await withTenant(app.db, owner.tenantId!, (client) => client.query(`UPDATE device_alerts SET ticket_due_at = now() - interval '1 minute' WHERE id = $1`, [pending.id]))
    const escalated = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: 120 })
    expect(escalated.tickets).toBe(1)
    const linked = await withTenant(app.db, owner.tenantId!, (client) => client.query('SELECT ticket_id FROM device_alerts WHERE id = $1', [pending.id]).then((result) => result.rows[0]))
    expect(linked.ticket_id).toBeTruthy()

    await withTenant(app.db, owner.tenantId!, (client) => client.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [deviceId]))
    const recovered = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: 120 })
    expect(recovered.resolved).toBe(1)
    const thread = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT body FROM ticket_threads WHERE ticket_id = $1 AND meta @> '{"event":"device_back_online"}'`, [linked.ticket_id]).then((result) => result.rows[0]))
    expect(thread.body).toContain('back online')
  })

  it('suppresses a battery-powered group but allows a critical override', async () => {
    const group = await app.inject({ method: 'POST', url: '/api/v1/device-groups', headers: authHeaders(owner), payload: { name: 'Critical laptops' } })
    expect(group.statusCode).toBe(201)
    const groupId = group.json().group.id as string
    await app.inject({ method: 'PATCH', url: `/api/v1/devices/${deviceId}`, headers: authHeaders(owner), payload: { groupId } })
    await withTenant(app.db, owner.tenantId!, (client) => client.query(`UPDATE devices SET power_source = 'battery', last_seen_at = now() - interval '20 minutes' WHERE id = $1`, [deviceId]))

    const policy = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/availability-policies', headers: authHeaders(owner),
      payload: { name: 'Battery group', groupId, offlineThresholdMinutes: 1, ticketMode: 'alert', suppressPowerStates: ['battery'], criticalOverride: false },
    })
    expect(policy.statusCode).toBe(201)
    const suppressed = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: 120 })
    expect(suppressed.offline).toBe(0)

    const override = await app.inject({ method: 'PATCH', url: `/api/v1/monitoring/availability-policies/${policy.json().policy.id}`, headers: authHeaders(owner), payload: { criticalOverride: true } })
    expect(override.statusCode).toBe(200)
    const raised = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: 120 })
    expect(raised.offline).toBe(1)
    const alert = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT severity FROM device_alerts WHERE device_id = $1 AND availability_policy_id = $2`, [deviceId, policy.json().policy.id]).then((result) => result.rows[0]))
    expect(alert.severity).toBe('critical')
  })

  it('rejects invalid timezones and isolates management permission', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/monitoring/availability-policies', headers: authHeaders(owner), payload: { name: 'Bad zone', timezone: 'Mars/Olympus' } })
    expect(invalid.statusCode).toBe(400)
  })
})
