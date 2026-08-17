import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { monitoringConditionMatches } from '../src/modules/monitoring/monitoring.js'

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
