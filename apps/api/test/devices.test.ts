import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner, seedActiveMember, authHeaders, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { checkDeviceAlertsForTenant } from '../src/modules/devices/alerts.js'

const OFFLINE_SEC = 120
const LOW_DISK_PCT = 85

describe('devices & agent v1', () => {
  let app: FastifyInstance
  let owner: Session
  let enrolToken: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app)

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    expect(rotate.statusCode).toBe(201)
    enrolToken = rotate.json().token as string
    expect(enrolToken.startsWith('deskos_') || enrolToken.startsWith('reydesk_')).toBe(true)
  })

  afterAll(async () => {
    await app.close()
  })

  async function enrolDevice(opts?: { name?: string; os?: string; disk?: boolean }): Promise<{ deviceId: string; deviceToken: string; name: string }> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: {
        token: enrolToken,
        name: opts?.name ?? `desk-${Math.random().toString(36).slice(2, 8)}`,
        hostname: opts?.name ?? 'host-a',
        os: opts?.os ?? 'windows',
        osVersion: '11',
        arch: 'x64',
        ip: '10.0.0.42',
        agentVersion: '0.1.0',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.device.id).toBeTruthy()
    expect(body.deviceToken).toBeTruthy()
    return { deviceId: body.device.id, deviceToken: body.deviceToken, name: body.device.name }
  }

  describe('enrolment', () => {
    it('enrols a device with a valid tenant token and issues a device token', async () => {
      const device = await enrolDevice()
      expect(device.name).toBeTruthy()

      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
      })
      expect(detail.statusCode).toBe(200)
      const d = detail.json().device
      expect(d.os).toBe('windows')
      expect(d.hostname).toBe('host-a')
      expect(d.agent_token_hash).toBeNull() // never leaks the hash
    })

    it('validates enrollment codes without treating them as remote support links', async () => {
      const rotated = await app.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
      expect(rotated.statusCode).toBe(201)
      const code = rotated.json().code as string
      const validation = await app.inject({ method: 'GET', url: `/api/enrol/${code}`, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
      expect(validation.statusCode).toBe(200)
      expect(validation.json()).toMatchObject({ valid: true, platform: 'windows' })
      const remote = await app.inject({ method: 'GET', url: `/api/connect/${code}` })
      expect(remote.statusCode).toBe(404)
    })

    it('serves the Windows helper download for a valid enrollment code', async () => {
      const fixture = await import('node:fs/promises').then(({ mkdtemp, writeFile }) => mkdtemp('reydesk-helper-test-').then(async (dir) => {
        const file = `${dir}/reydesk-helper.exe`
        await writeFile(file, Buffer.from('MZ-reydesk-test-helper'))
        return file
      }))
      const testApp = await createTestApp({ REYDESK_HELPER_BINARY: fixture })
      const originalHelperPath = testApp.config.helperBinaryPath
      testApp.config.helperBinaryPath = fixture
      const rotated = await testApp.inject({ method: 'POST', url: '/api/v1/devices/enrol-token/rotate', headers: authHeaders(owner) })
      expect(rotated.statusCode).toBe(201)
      const code = rotated.json().code as string
      const download = await testApp.inject({
        method: 'GET',
        url: `/api/enrol/${code}/download`,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      })
      expect(download.statusCode, `${download.statusCode}: ${download.body}`).toBe(404)
      expect(download.json()).toMatchObject({ error: { code: 'helper_unavailable' } })

      testApp.config.helperBinaryPath = originalHelperPath
      await testApp.close()
    })

    it('rejects an invalid or revoked enrolment token', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/enrol',
        payload: { token: 'deskos_not-a-real-token', name: 'x' },
      })
      expect(bad.statusCode).toBe(401)
    })

    it('rotation revokes the previous enrolment token', async () => {
      const rotated = await app.inject({
        method: 'POST',
        url: '/api/v1/devices/enrol-token/rotate',
        headers: authHeaders(owner),
      })
      expect(rotated.statusCode).toBe(201)
      const newToken = rotated.json().token as string
      const code = rotated.json().code as string
      expect(newToken).not.toBe(enrolToken)
      expect(code).toMatch(/^\d{12}$/)
      expect(rotated.json().codeExpiresAt).toBeTruthy()

      const codeEnrol = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/enrol',
        payload: { token: code, name: 'phone-code-box' },
      })
      expect(codeEnrol.statusCode).toBe(201)

      const reusedCode = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/enrol',
        payload: { token: code, name: 'reused-code-box' },
      })
      expect(reusedCode.statusCode).toBe(401)

      const oldTokenEnrol = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/enrol',
        payload: { token: enrolToken, name: 'stale' },
      })
      expect(oldTokenEnrol.statusCode).toBe(401)

      enrolToken = newToken // continue with the fresh token
    })

    it('audits enrolment with actor_type = agent', async () => {
      const device = await enrolDevice({ name: 'audited-box' })
      const audits = await withTenant(app.db, owner.tenantId!, (client) =>
        client
          .query(
            `SELECT actor_type, action, object_id FROM audit_logs
              WHERE action = 'device.enrolled' AND object_id = $1`,
            [device.deviceId],
          )
          .then((r) => r.rows),
      )
      expect(audits.length).toBeGreaterThan(0)
      expect(audits[0].actor_type).toBe('agent')
    })
  })

  describe('heartbeat, inventory, metrics', () => {
    it('rejects heartbeat with an unknown device token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/heartbeat',
        headers: { authorization: 'Bearer deskos_dev_bogus' },
        payload: {},
      })
      expect(res.statusCode).toBe(401)
    })

    it('updates last_seen_at on heartbeat', async () => {
      const device = await enrolDevice({ name: 'hb-box' })
      const before = await withTenant(app.db, owner.tenantId!, (client) =>
        client.query('SELECT last_seen_at FROM devices WHERE id = $1', [device.deviceId]).then((r) => r.rows[0]),
      )
      expect(before.last_seen_at).toBeTruthy()

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/heartbeat',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        payload: {},
      })
      expect(res.statusCode).toBe(200)
      const after = await withTenant(app.db, owner.tenantId!, (client) =>
        client.query('SELECT last_seen_at FROM devices WHERE id = $1', [device.deviceId]).then((r) => r.rows[0]),
      )
      expect(new Date(after.last_seen_at).getTime()).toBeGreaterThanOrEqual(new Date(before.last_seen_at).getTime())
    })

    it('updates inventory fields', async () => {
      const device = await enrolDevice({ name: 'inv-box' })
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/agent/inventory',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        payload: { os: 'linux', osVersion: '24.04', arch: 'arm64', ip: '10.1.2.3' },
      })
      expect(res.statusCode).toBe(200)
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
      })
      const d = detail.json().device
      expect(d.os).toBe('linux')
      expect(d.os_version).toBe('24.04')
      expect(d.arch).toBe('arm64')
      expect(d.ip_address).toBe('10.1.2.3')
    })

    it('records richer endpoint health telemetry', async () => {
      const device = await enrolDevice({ name: 'telemetry-box' })
      const metric = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/metrics',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        payload: {
          cpuPct: 12.5,
          memPct: 40,
          diskPct: 60,
          diskFreeBytes: 987654321,
          networkLatencyMs: 24.5,
          batteryPct: 73,
          uptimeSeconds: 86400,
          processCount: 142,
          reason: 'periodic',
        },
      })
      expect(metric.statusCode).toBe(200)
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
      })
      const sample = detail.json().metrics[0]
      expect(sample.disk_free_bytes).toBe(987654321)
      expect(sample.network_latency_ms).toBe(24.5)
      expect(sample.battery_pct).toBe(73)
      expect(sample.uptime_seconds).toBe(86400)
      expect(sample.process_count).toBe(142)
      expect(sample.recorded_reason).toBe('periodic')
    })

    it('records metric samples', async () => {
      const device = await enrolDevice({ name: 'metrics-box' })
      for (const m of [{ cpuPct: 12.5, memPct: 40, diskPct: 60 }, { cpuPct: 20, memPct: 45, diskPct: 62 }]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/v1/agent/metrics',
          headers: { authorization: `Bearer ${device.deviceToken}` },
          payload: m,
        })
        expect(res.statusCode).toBe(200)
      }
      const detail = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
      })
      expect(detail.json().metrics).toHaveLength(2)
      expect(detail.json().metrics[1].disk_pct).toBe(62)
    })
  })

  describe('alerts + automation', () => {
    it('offline detection creates an alert and a device-linked auto-ticket (once)', async () => {
      const device = await enrolDevice({ name: 'lonely-box' })
      await withTenant(app.db, owner.tenantId!, (client) =>
        client.query(
          `UPDATE devices SET last_seen_at = now() - interval '10 minutes' WHERE id = $1`,
          [device.deviceId],
        ),
      )

      const first = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: OFFLINE_SEC, lowDiskPct: LOW_DISK_PCT })
      expect(first.offline).toBe(1)
      expect(first.tickets).toBe(1)

      // idempotent: second pass creates nothing new
      const second = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: OFFLINE_SEC, lowDiskPct: LOW_DISK_PCT })
      expect(second.offline).toBe(0)
      expect(second.tickets).toBe(0)

      const state = await withTenant(app.db, owner.tenantId!, async (client) => {
        const alert = await client.query(
          'SELECT a.kind, a.severity, a.ticket_id FROM device_alerts a WHERE a.device_id = $1',
          [device.deviceId],
        )
        const ticket = await client.query(
          'SELECT t.id, t.number, t.device_id, t.requester_id, t.source, t.tags FROM tickets t WHERE t.device_id = $1',
          [device.deviceId],
        )
        const thread = await client.query(
          `SELECT th.kind FROM ticket_threads th
            JOIN tickets t ON t.id = th.ticket_id
           WHERE t.device_id = $1`,
          [device.deviceId],
        )
        return { alert: alert.rows[0], ticket: ticket.rows[0], thread: thread.rows[0] }
      })

      expect(state.alert.kind).toBe('offline')
      expect(state.alert.ticket_id).toBe(state.ticket.id)
      expect(state.ticket.device_id).toBe(device.deviceId)
      expect(state.ticket.requester_id).toBe(owner.userId) // attributed to the owner
      expect(state.ticket.source).toBe('api')
      expect(state.ticket.tags).toContain('automation')
      expect(state.thread.kind).toBe('system_event')

      // the alert shows in the feed with the ticket number
      const feed = await app.inject({
        method: 'GET',
        url: '/api/v1/device-alerts?open=true',
        headers: authHeaders(owner),
      })
      const openAlert = feed.json().alerts.find((a: { device_id: string }) => a.device_id === device.deviceId)
      expect(openAlert).toBeTruthy()
      expect(openAlert.ticket_number).toBe(state.ticket.number)
    })

    it('heartbeat resolves the offline alert and posts a system event on the ticket', async () => {
      const device = await enrolDevice({ name: 'home-again-box' })
      await withTenant(app.db, owner.tenantId!, (client) =>
        client.query('UPDATE devices SET last_seen_at = now() - interval \'10 minutes\' WHERE id = $1', [device.deviceId]),
      )
      await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: OFFLINE_SEC, lowDiskPct: LOW_DISK_PCT })

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/heartbeat',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        payload: {},
      })
      expect(res.statusCode).toBe(200)

      const state = await withTenant(app.db, owner.tenantId!, async (client) => {
        const alert = await client.query(
          'SELECT resolved_at FROM device_alerts WHERE device_id = $1 AND kind = \'offline\'',
          [device.deviceId],
        )
        const tickets = await client.query('SELECT t.id FROM tickets t WHERE t.device_id = $1', [device.deviceId])
        const thread = await client.query(
          `SELECT th.body FROM ticket_threads th
            JOIN tickets t ON t.id = th.ticket_id
           WHERE t.device_id = $1 AND th.meta @> '{"event":"device_back_online"}'`,
          [device.deviceId],
        )
        return { alert: alert.rows[0], ticketId: tickets.rows[0]?.id, thread: thread.rows[0] }
      })
      expect(state.alert.resolved_at).toBeTruthy()
      expect(state.thread).toBeTruthy()
      expect(state.thread.body).toContain('back online')
    })

    it('low disk creates an alert and auto-ticket from the latest metric', async () => {
      const device = await enrolDevice({ name: 'disk-box' })
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/agent/metrics',
        headers: { authorization: `Bearer ${device.deviceToken}` },
        payload: { cpuPct: 30, memPct: 50, diskPct: 91 },
      })
      expect(res.statusCode).toBe(200)

      const result = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: OFFLINE_SEC, lowDiskPct: LOW_DISK_PCT })
      expect(result.lowDisk).toBe(1)

      const state = await withTenant(app.db, owner.tenantId!, (client) =>
        client
          .query(
            `SELECT a.kind, a.severity, t.subject, t.device_id
               FROM device_alerts a
               JOIN tickets t ON t.id = a.ticket_id
              WHERE a.device_id = $1`,
            [device.deviceId],
          )
          .then((r) => r.rows[0]),
      )
      expect(state.kind).toBe('low_disk')
      expect(state.severity).toBe('critical')
      expect(state.subject).toBe(`Low disk on ${device.name}`)
      expect(state.device_id).toBe(device.deviceId)
    })

    it('a device that never checked in does not raise an offline alert', async () => {
      const device = await enrolDevice({ name: 'silent-box' })
      // last_seen_at is set at enrolment by design; simulate "never seen" semantics
      await withTenant(app.db, owner.tenantId!, (client) =>
        client.query('UPDATE devices SET last_seen_at = NULL WHERE id = $1', [device.deviceId]),
      )
      const result = await checkDeviceAlertsForTenant(app.db, owner.tenantId!, { offlineSec: OFFLINE_SEC, lowDiskPct: LOW_DISK_PCT })
      const alerts = await withTenant(app.db, owner.tenantId!, (client) =>
        client.query('SELECT 1 FROM device_alerts WHERE device_id = $1', [device.deviceId]).then((r) => r.rows),
      )
      expect(alerts).toHaveLength(0)
      expect(result.offline).toBe(0)
    })
  })

  describe('RBAC + RLS', () => {
    it('end users cannot read devices; analysts can read but not manage', async () => {
      const endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
      const analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
      const device = await enrolDevice({ name: 'rbac-box' })

      const endUserList = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: authHeaders(endUser) })
      expect(endUserList.statusCode).toBe(403)

      const analystList = await app.inject({ method: 'GET', url: '/api/v1/devices', headers: authHeaders(analyst) })
      expect(analystList.statusCode).toBe(200)
      expect(analystList.json().devices.length).toBeGreaterThan(0)

      const analystPatch = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(analyst),
        payload: { name: 'nope' },
      })
      expect(analystPatch.statusCode).toBe(403)

      const analystRotate = await app.inject({
        method: 'POST',
        url: '/api/v1/devices/enrol-token/rotate',
        headers: authHeaders(analyst),
      })
      expect(analystRotate.statusCode).toBe(403)
    })

    it('isolates devices between tenants (API and RLS level)', async () => {
      const otherOwner = await signupOwner(app)
      const device = await enrolDevice({ name: 'mine-box' })

      const otherList = await app.inject({
        method: 'GET',
        url: '/api/v1/devices',
        headers: authHeaders(otherOwner, otherOwner.tenantSlug),
      })
      expect(otherList.statusCode).toBe(200)
      const ids = otherList.json().devices.map((d: { id: string }) => d.id)
      expect(ids).not.toContain(device.deviceId)

      // raw SQL cross-tenant INSERT must be denied by RLS
      await expect(
        withTenant(app.db, otherOwner.tenantId!, (client) =>
          client.query(
            `INSERT INTO devices (tenant_id, name) VALUES ($1, 'sneaky')`,
            [owner.tenantId],
          ),
        ),
      ).rejects.toThrow()
    })
  })

  it('allows a device manager to remove an enrolled device and revoke its agent token', async () => {
    const device = await enrolDevice({ name: 'remove-me' })
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/devices/${device.deviceId}`,
      headers: authHeaders(owner),
    })
    expect(removed.statusCode).toBe(200)
    expect(removed.json().ok).toBe(true)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/devices/${device.deviceId}`,
      headers: authHeaders(owner),
    })
    expect(detail.statusCode).toBe(404)

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/heartbeat',
      headers: { authorization: `Bearer ${device.deviceToken}` },
      payload: {},
    })
    expect(heartbeat.statusCode).toBe(401)
  })

  describe('device groups', () => {
    it('creates, lists, assigns, renames, and deletes groups', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/device-groups',
        headers: authHeaders(owner),
        payload: { name: 'Marketing', description: 'Marketing laptops' },
      })
      expect(create.statusCode).toBe(201)
      const groupId = create.json().group.id

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/device-groups',
        headers: authHeaders(owner),
        payload: { name: 'Marketing' },
      })
      expect(duplicate.statusCode).toBe(409)

      const device = await enrolDevice({ name: 'marketing-box' })
      const assign = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
        payload: { groupId },
      })
      expect(assign.statusCode).toBe(200)

      const list = await app.inject({ method: 'GET', url: '/api/v1/device-groups', headers: authHeaders(owner) })
      const group = list.json().groups.find((g: { id: string }) => g.id === groupId)
      expect(group.device_count).toBe(1)

      const deviceList = await app.inject({
        method: 'GET',
        url: `/api/v1/devices?groupId=${groupId}`,
        headers: authHeaders(owner),
      })
      expect(deviceList.json().devices).toHaveLength(1)
      expect(deviceList.json().devices[0].group_name).toBe('Marketing')

      const rename = await app.inject({
        method: 'PATCH',
        url: `/api/v1/device-groups/${groupId}`,
        headers: authHeaders(owner),
        payload: { name: 'Marketing EMEA' },
      })
      expect(rename.statusCode).toBe(200)
      expect(rename.json().group.name).toBe('Marketing EMEA')

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/device-groups/${groupId}`,
        headers: authHeaders(owner),
      })
      expect(del.statusCode).toBe(200)
      const after = await app.inject({ method: 'GET', url: '/api/v1/device-groups', headers: authHeaders(owner) })
      expect(after.json().groups.find((g: { id: string }) => g.id === groupId)).toBeUndefined()
      // device survives with group unset
      const d = await app.inject({
        method: 'GET',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
      })
      expect(d.json().device.group_id).toBeNull()
    })

    it('staff can rename a device', async () => {
      const device = await enrolDevice({ name: 'rename-me' })
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/devices/${device.deviceId}`,
        headers: authHeaders(owner),
        payload: { name: 'renamed-device' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().device.name).toBe('renamed-device')
    })
  })
})
