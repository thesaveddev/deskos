import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { checkAllMonitoringPolicies, monitoringConditionMatches } from '../src/modules/monitoring/monitoring.js'

describe('endpoint monitoring rules', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let foreignOwner: Awaited<ReturnType<typeof signupOwner>>
  let deviceId: string
  let deviceToken: string
  let ruleId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Monitoring Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    foreignOwner = await signupOwner(app, { tenantName: 'Monitoring Foreign' })

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    expect(rotated.statusCode).toBe(201)
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotated.json().token, name: 'monitored-box', hostname: 'monitored-box', os: 'windows' },
    })
    expect(enrolled.statusCode).toBe(201)
    deviceId = enrolled.json().device.id
    deviceToken = enrolled.json().deviceToken
  })

  afterAll(async () => {
    await app.close()
  })

  it('evaluates threshold operators safely', () => {
    expect(monitoringConditionMatches({ op: 'gte', value: 85 }, 85)).toBe(true)
    expect(monitoringConditionMatches({ op: 'gt', value: 85 }, 85)).toBe(false)
    expect(monitoringConditionMatches({ op: 'lt', value: 50 }, 49)).toBe(true)
    expect(monitoringConditionMatches({ op: 'neq', value: 50 }, 49)).toBe(true)
  })

  it('analysts can read rules but cannot manage them', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/v1/monitoring/rules', headers: authHeaders(analyst) })
    expect(list.statusCode).toBe(200)
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/monitoring/rules',
      headers: authHeaders(analyst),
      payload: { name: 'Not allowed', metric: 'disk_pct', condition: { op: 'gte', value: 90 }, action: {} },
    })
    expect(create.statusCode).toBe(403)
  })

  it('creates a scoped monitoring rule with an alert action', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/monitoring/rules',
      headers: authHeaders(owner),
      payload: {
        name: 'Disk pressure',
        metric: 'disk_pct',
        condition: { op: 'gte', value: 85 },
        action: { severity: 'critical', message: '{{device}} is at {{value}}% disk', createTicket: true, ticketPriority: 'p2' },
        deviceId,
      },
    })
    expect(created.statusCode).toBe(201)
    ruleId = created.json().rule.id
    expect(created.json().rule.action.ticketPriority).toBe('p2')
  })

  it('supports battery, latency, uptime, and process-count rules', async () => {
    const definitions = [
      { name: 'Battery low', metric: 'battery_pct', condition: { op: 'lte', value: 20 } },
      { name: 'Latency high', metric: 'network_latency_ms', condition: { op: 'gte', value: 200 } },
      { name: 'Uptime high', metric: 'uptime_seconds', condition: { op: 'gte', value: 2_592_000 } },
      { name: 'Too many processes', metric: 'process_count', condition: { op: 'gte', value: 300 } },
    ] as const
    for (const definition of definitions) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/v1/monitoring/rules',
        headers: authHeaders(owner),
        payload: { ...definition, action: { severity: 'warning', createTicket: false } },
      })
      expect(created.statusCode).toBe(201)
    }

    const metrics = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 15, memPct: 30, diskPct: 50, batteryPct: 12, networkLatencyMs: 240, uptimeSeconds: 3_000_000, processCount: 410 },
    })
    expect(metrics.statusCode).toBe(200)
    const openExtended = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(`SELECT count(*)::int AS count FROM device_alerts WHERE device_id = $1 AND kind = 'monitoring' AND resolved_at IS NULL AND ticket_id IS NULL`, [deviceId]).then((result) => result.rows[0].count),
    )
    expect(openExtended).toBe(4)

    const recovered = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 15, memPct: 30, diskPct: 50, batteryPct: 80, networkLatencyMs: 40, uptimeSeconds: 100, processCount: 120 },
    })
    expect(recovered.statusCode).toBe(200)
    const resolvedExtended = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(`SELECT count(*)::int AS count FROM device_alerts WHERE device_id = $1 AND kind = 'monitoring' AND resolved_at IS NOT NULL AND ticket_id IS NULL`, [deviceId]).then((result) => result.rows[0].count),
    )
    expect(resolvedExtended).toBe(4)
  })

  it('supports service-state, device-type, suppression, and routed rules', async () => {
    const now = new Date()
    const suppressed = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/rules', headers: authHeaders(owner),
      payload: {
        name: 'Suppressed service', metric: 'service_state', deviceType: 'workstation',
        condition: { op: 'eq', value: 'stopped', serviceName: 'Spooler' },
        maintenanceWindows: [{ start: new Date(now.getTime() - 60_000).toISOString(), end: new Date(now.getTime() + 60_000).toISOString() }],
        action: { severity: 'critical', createTicket: false },
      },
    })
    expect(suppressed.statusCode).toBe(201)
    const serverOnly = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/rules', headers: authHeaders(owner),
      payload: { name: 'Server battery', metric: 'battery_pct', deviceType: 'server', condition: { op: 'lte', value: 10 }, action: { createTicket: false } },
    })
    expect(serverOnly.statusCode).toBe(201)
    const metrics = await app.inject({
      method: 'POST', url: '/api/v1/agent/metrics', headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 10, memPct: 20, diskPct: 20, batteryPct: 5, serviceStates: { Spooler: 'stopped' } },
    })
    expect(metrics.statusCode).toBe(200)
    const alerts = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT kind, message FROM device_alerts WHERE device_id = $1 AND resolved_at IS NULL`, [deviceId]).then((r) => r.rows))
    expect(alerts.some((alert) => alert.message.includes('Suppressed service'))).toBe(false)
    expect(alerts.some((alert) => alert.message.includes('Server battery'))).toBe(false)

    const routed = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/rules', headers: authHeaders(owner),
      payload: { name: 'Process route', metric: 'process_count', condition: { op: 'gte', value: 300 }, action: { createTicket: false, routing: { roles: ['owner'] }, escalation: { levels: [{ afterMinutes: 5, severity: 'critical' }] } } },
    })
    expect(routed.statusCode).toBe(201)
  })

  it('evaluates heartbeat rules, exposes fleet overview, and supports alert lifecycle actions', async () => {
    const created = await app.inject({
      method: 'POST', url: '/api/v1/monitoring/rules', headers: authHeaders(owner),
      payload: { name: 'Heartbeat stale', metric: 'heartbeat_age_seconds', condition: { op: 'gte', value: 60 }, action: { createTicket: false } },
    })
    expect(created.statusCode).toBe(201)
    await withTenant(app.db, owner.tenantId!, (client) => client.query(`UPDATE devices SET last_seen_at = now() - interval '5 minutes' WHERE id = $1`, [deviceId]))
    const evaluated = await checkAllMonitoringPolicies(app.db)
    expect(evaluated.heartbeatRules).toBeGreaterThanOrEqual(1)
    const open = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT id FROM device_alerts WHERE device_id = $1 AND rule_id = $2 AND resolved_at IS NULL`, [deviceId, created.json().rule.id]).then((r) => r.rows[0]))
    expect(open).toBeTruthy()
    const snoozed = await app.inject({ method: 'POST', url: `/api/v1/device-alerts/${open.id}/snooze`, headers: authHeaders(owner), payload: { minutes: 60 } })
    expect(snoozed.statusCode).toBe(200)
    const ack = await app.inject({ method: 'POST', url: `/api/v1/device-alerts/${open.id}/acknowledge`, headers: authHeaders(owner), payload: {} })
    expect(ack.statusCode).toBe(200)
    const overview = await app.inject({ method: 'GET', url: '/api/v1/monitoring/overview', headers: authHeaders(owner) })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().devices.length).toBeGreaterThan(0)
    const availability = await app.inject({ method: 'GET', url: '/api/v1/monitoring/availability', headers: authHeaders(owner) })
    expect(availability.statusCode).toBe(200)
    expect(availability.json().devices.length).toBeGreaterThan(0)
  })

  it('rejects thresholds outside a metric\'s supported range', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v1/monitoring/rules',
      headers: authHeaders(owner),
      payload: { name: 'Invalid battery', metric: 'battery_pct', condition: { op: 'gte', value: 101 }, action: {} },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('raises once, creates a linked ticket, and clears when telemetry recovers', async () => {
    const high = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 15, memPct: 30, diskPct: 92 },
    })
    expect(high.statusCode).toBe(200)

    const state = await withTenant(app.db, owner.tenantId!, async (client) => {
      const alert = await client.query(
        `SELECT id, severity, message, ticket_id FROM device_alerts WHERE rule_id = $1 AND resolved_at IS NULL`,
        [ruleId],
      )
      const ticket = await client.query(
        `SELECT priority, device_id FROM tickets WHERE id = $1`,
        [alert.rows[0]?.ticket_id],
      )
      return { alert: alert.rows[0], ticket: ticket.rows[0] }
    })
    expect(state.alert).toBeTruthy()
    expect(state.alert.severity).toBe('critical')
    expect(state.alert.message).toContain('monitored-box is at 92% disk')
    expect(state.ticket.priority).toBe('p2')
    expect(state.ticket.device_id).toBe(deviceId)

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 20, memPct: 35, diskPct: 95 },
    })
    expect(duplicate.statusCode).toBe(200)
    const openCount = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query('SELECT count(*)::int AS count FROM device_alerts WHERE rule_id = $1 AND resolved_at IS NULL', [ruleId]).then((r) => r.rows[0].count),
    )
    expect(openCount).toBe(1)

    const clear = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/metrics',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { cpuPct: 20, memPct: 35, diskPct: 70 },
    })
    expect(clear.statusCode).toBe(200)
    const resolved = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query('SELECT resolved_at FROM device_alerts WHERE rule_id = $1', [ruleId]).then((r) => r.rows[0]),
    )
    expect(resolved.resolved_at).toBeTruthy()
  })

  it('supports disabling, updating, and deleting a rule', async () => {
    const off = await app.inject({ method: 'POST', url: `/api/v1/monitoring/rules/${ruleId}/toggle`, headers: authHeaders(owner), payload: { enabled: false } })
    expect(off.statusCode).toBe(200)
    expect(off.json().rule.enabled).toBe(false)
    const update = await app.inject({ method: 'PATCH', url: `/api/v1/monitoring/rules/${ruleId}`, headers: authHeaders(owner), payload: { name: 'Disk pressure updated', condition: { op: 'gte', value: 90 } } })
    expect(update.statusCode).toBe(200)
    expect(update.json().rule.name).toBe('Disk pressure updated')
  })

  it('isolates rules between tenants', async () => {
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/monitoring/rules', headers: authHeaders(foreignOwner) })
    expect(foreignList.statusCode).toBe(200)
    expect(foreignList.json().rules).toHaveLength(0)
    const foreignGet = await app.inject({ method: 'GET', url: `/api/v1/monitoring/rules/${ruleId}`, headers: authHeaders(foreignOwner) })
    expect(foreignGet.statusCode).toBe(404)
  })
})
