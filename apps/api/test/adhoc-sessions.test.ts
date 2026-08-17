import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

describe('ad-hoc (unmanaged) support sessions', () => {
  let app: FastifyInstance
  let owner: Session

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Adhoc Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('lets a technician generate a short-lived code and connect link', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen', 'control_input'], reason: 'Printer help' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().code).toMatch(/^\d{8}$/)
    expect(res.json().connectUrl).toContain(`/connect/${res.json().code}`)
    expect(res.json().expiresAt).toBeTruthy()
  })

  it('requires remote.attended permission to generate a code', async () => {
    const auditor = await seedActiveMember(app, owner.tenantId!, 'auditor')
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(auditor),
      payload: { permissions: ['view_screen'] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('serves public session info and rejects unknown codes', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen'], reason: 'Screen share' },
    })
    const { code } = created.json()

    const info = await app.inject({ method: 'GET', url: `/api/connect/${code}` })
    expect(info.statusCode).toBe(200)
    expect(info.json().state).toBe('open')
    expect(info.json().reason).toBe('Screen share')

    const missing = await app.inject({ method: 'GET', url: '/api/connect/00000000' })
    expect(missing.statusCode).toBe(404)
  })

  it('claims the code once, creates an ephemeral device and session, and rejects reuse', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen'], reason: 'Claim test' },
    })
    const { code } = created.json()

    const claim = await app.inject({
      method: 'POST',
      url: `/api/connect/${code}/claim`,
      payload: { name: 'customer-laptop', os: 'windows' },
    })
    expect(claim.statusCode).toBe(201)
    expect(claim.json().device.id).toBeTruthy()
    expect(claim.json().device.name).toBe('customer-laptop')
    expect(claim.json().deviceToken).toMatch(/^deskos_dev_/)
    expect(claim.json().session.id).toBeTruthy()
    expect(claim.json().relayUrl).toMatch(/^ws:/)

    // The claimed code is single-use.
    const reuse = await app.inject({
      method: 'POST',
      url: `/api/connect/${code}/claim`,
      payload: { name: 'second-machine', os: 'windows' },
    })
    expect(reuse.statusCode).toBe(409)

    // The ephemeral device can now authenticate and see its pending session.
    const sessions = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/sessions',
      headers: { authorization: `Bearer ${claim.json().deviceToken}` },
    })
    expect(sessions.statusCode).toBe(200)
    expect(sessions.json().sessions.map((session: { id: string }) => session.id)).toContain(claim.json().session.id)
  })

  it('links the claimed session to the issuing technician (participants + event + live state)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen'], reason: 'Parity test' },
    })
    const { code } = created.json()

    const claim = await app.inject({
      method: 'POST',
      url: `/api/connect/${code}/claim`,
      payload: { name: 'parity-laptop', os: 'windows' },
    })
    expect(claim.statusCode).toBe(201)
    const sessionId = claim.json().session.id as string

    // The issuing technician owns the session, like the managed create path.
    await withTenant(app.db, owner.tenantId!, async (client) => {
      const participants = await client.query(
        'SELECT user_id, role FROM session_participants WHERE session_id = $1',
        [sessionId],
      )
      expect(participants.rows).toContainEqual({ user_id: owner.userId, role: 'owner' })
      const events = await client.query(
        'SELECT event FROM session_events WHERE session_id = $1',
        [sessionId],
      )
      expect(events.rows.map((row) => row.event)).toContain('session.created')
    })

    // The support-code list exposes the live session so the console can deep-link.
    const list = await app.inject({ method: 'GET', url: '/api/v1/adhoc-sessions', headers: authHeaders(owner) })
    const record = list.json().sessions.find((session: { remote_session_id: string }) => session.remote_session_id === sessionId)
    expect(record).toBeTruthy()
    expect(record.remote_session_state).toBe('consent_pending')
    expect(record.state).toBe('claimed')
  })

  it('expires codes that are no longer valid', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen'], reason: 'Expiry test' },
    })
    const { code, id } = created.json()

    await withTenant(app.db, owner.tenantId!, (client) =>
      client.query("UPDATE adhoc_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]),
    )

    const info = await app.inject({ method: 'GET', url: `/api/connect/${code}` })
    expect(info.statusCode).toBe(404)

    const claim = await app.inject({ method: 'POST', url: `/api/connect/${code}/claim`, payload: { name: 'late' } })
    expect(claim.statusCode).toBe(404)
  })

  it('rejects helper download when no binary is configured', async () => {
    const noHelperApp = await createTestApp({ DESKOS_HELPER_BINARY: '' })
    try {
      const noHelperOwner = await signupOwner(noHelperApp, { tenantName: 'No Helper Org' })
      const created = await noHelperApp.inject({
        method: 'POST',
        url: '/api/v1/adhoc-sessions',
        headers: authHeaders(noHelperOwner),
        payload: { permissions: ['view_screen'], reason: 'Download test' },
      })
      const { code } = created.json()

      const res = await noHelperApp.inject({ method: 'GET', url: `/api/connect/${code}/download` })
      expect(res.statusCode).toBe(404)
      expect(res.json().error.code).toBe('helper_unavailable')
    } finally {
      await noHelperApp.close()
    }
  })

  it('rejects helper download for an unknown code', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/connect/00000000/download' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('streams the configured helper binary for a valid open code', async () => {
    const binary = path.join(os.tmpdir(), `deskos-helper-${randomBytes(4).toString('hex')}.exe`)
    writeFileSync(binary, 'MZ-fake-helper-binary')
    const helperApp = await createTestApp({ DESKOS_HELPER_BINARY: binary })
    try {
      const helperOwner = await signupOwner(helperApp, { tenantName: 'Helper Org' })
      const created = await helperApp.inject({
        method: 'POST',
        url: '/api/v1/adhoc-sessions',
        headers: authHeaders(helperOwner),
        payload: { permissions: ['view_screen'], reason: 'Download stream test' },
      })
      const { code } = created.json()

      const res = await helperApp.inject({ method: 'GET', url: `/api/connect/${code}/download` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('application/octet-stream')
      expect(res.headers['content-disposition']).toContain('deskos-helper.exe')
      expect(res.body).toContain('MZ-fake-helper-binary')
    } finally {
      await helperApp.close()
      rmSync(binary, { force: true })
    }
  })

  it('lists support codes and revokes open ones', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/adhoc-sessions',
      headers: authHeaders(owner),
      payload: { permissions: ['view_screen'], reason: 'List test' },
    })
    const { id, code } = created.json()

    const list = await app.inject({ method: 'GET', url: '/api/v1/adhoc-sessions', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(list.json().sessions.map((session: { id: string }) => session.id)).toContain(id)
    expect(list.json().sessions.find((session: { id: string }) => session.id === id).state).toBe('open')

    const revoke = await app.inject({
      method: 'POST',
      url: `/api/v1/adhoc-sessions/${id}/revoke`,
      headers: authHeaders(owner),
      payload: {},
    })
    expect(revoke.statusCode).toBe(200)
    expect(revoke.json().state).toBe('expired')

    const info = await app.inject({ method: 'GET', url: `/api/connect/${code}` })
    expect(info.statusCode).toBe(404)

    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/adhoc-sessions/${id}/revoke`,
      headers: authHeaders(owner),
      payload: {},
    })
    expect(again.statusCode).toBe(409)
  })

  it('requires remote.attended to list support codes', async () => {
    const auditor = await seedActiveMember(app, owner.tenantId!, 'auditor')
    const res = await app.inject({ method: 'GET', url: '/api/v1/adhoc-sessions', headers: authHeaders(auditor) })
    expect(res.statusCode).toBe(403)
  })
})
