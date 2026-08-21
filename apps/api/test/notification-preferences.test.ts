import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { notifyInTxn } from '../src/core/notify.js'
import { withTenant } from '../src/db/pool.js'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('notification preferences', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Prefs Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
  })

  afterAll(async () => {
    await app.close()
  })

  it('lists canonical kinds with defaults', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/notification-preferences', headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    const prefs = res.json().preferences as Array<{ kind: string; enabled: boolean; channels: string[] }>
    expect(prefs.length).toBeGreaterThanOrEqual(10)
    expect(prefs.every((p) => p.enabled && p.channels.includes('in_app'))).toBe(true)
  })

  it('muting a kind suppresses delivery', async () => {
    const mute = await app.inject({
      method: 'PUT',
      url: '/api/v1/notification-preferences/ticket.resolved',
      headers: authHeaders(owner),
      payload: { enabled: false },
    })
    expect(mute.statusCode).toBe(200)

    const delivered = await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'ticket.resolved',
      body: 'should be muted',
    })
    expect(delivered).toBe(false)

    const rows = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(`SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'ticket.resolved'`, [owner.userId]),
    )
    expect(rows.rowCount).toBe(0)
  })

  it('a non-muted kind is still delivered with default in_app channel', async () => {
    const delivered = await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'sla.breached',
      body: 'sla hit',
    })
    expect(delivered).toBe(true)

    const rows = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(`SELECT channels FROM notifications WHERE user_id = $1 AND kind = 'sla.breached'`, [owner.userId]),
    )
    expect(rows.rows[0].channels).toEqual(['in_app'])
  })

  it('re-channelling records the requested channels', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/notification-preferences/ticket.replied',
      headers: authHeaders(owner),
      payload: { channels: ['email'] },
    })
    await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'ticket.replied',
      body: 'reply arrived',
    })
    const rows = await withTenant(app.db, owner.tenantId!, (client) =>
      client.query(`SELECT channels FROM notifications WHERE user_id = $1 AND kind = 'ticket.replied'`, [owner.userId]),
    )
    expect(rows.rows[0].channels).toEqual(['email'])
  })

  it('empty channels suppress delivery', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/notification-preferences/device.alert',
      headers: authHeaders(owner),
      payload: { channels: [] },
    })
    const delivered = await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'device.alert',
      body: 'disk low',
    })
    expect(delivered).toBe(false)
  })

  it('lists notifications and marks selected rows read', async () => {
    await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'membership.invited',
      body: 'A new notification for the bell.',
      subjectType: 'ticket',
      subjectId: 'notification-test',
    })
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const item = list.json().notifications.find((notification: { body: string }) => notification.body === 'A new notification for the bell.')
    expect(item).toBeTruthy()
    expect(item.read_at).toBeNull()

    const read = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/read',
      headers: authHeaders(owner),
      payload: { ids: [item.id] },
    })
    expect(read.statusCode).toBe(200)
    expect(read.json().updated).toBe(1)

    const after = await app.inject({ method: 'GET', url: '/api/v1/notifications', headers: authHeaders(owner) })
    const updated = after.json().notifications.find((notification: { id: string }) => notification.id === item.id)
    expect(updated.read_at).not.toBeNull()
  })

  it('delete resets a kind to defaults', async () => {
    await app.inject({
      method: 'DELETE',
      url: '/api/v1/notification-preferences/ticket.resolved',
      headers: authHeaders(owner),
    })
    const delivered = await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'ticket.resolved',
      body: 'now delivered again',
    })
    expect(delivered).toBe(true)
  })

  it('preferences are per-user and tenant-isolated', async () => {
    // Analyst muting a kind must not affect the owner's delivery.
    await app.inject({
      method: 'PUT',
      url: '/api/v1/notification-preferences/sla.breached',
      headers: authHeaders(analyst),
      payload: { enabled: false },
    })
    const delivered = await notifyInTxn(app.db, owner.tenantId!, {
      userId: owner.userId,
      kind: 'sla.breached',
      body: 'owner still gets this',
    })
    expect(delivered).toBe(true)

    const analystPrefs = await app.inject({
      method: 'GET',
      url: '/api/v1/notification-preferences',
      headers: authHeaders(analyst),
    })
    const sla = analystPrefs.json().preferences.find((p: { kind: string }) => p.kind === 'sla.breached')
    expect(sla.enabled).toBe(false)
  })
})
