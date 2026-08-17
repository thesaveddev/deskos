import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildIceServers, verifyTurnCredential } from '../src/core/ice.js'
import { authHeaders, createTestApp, signupOwner, type Session } from './helpers.js'

const TURN_SECRET = 'coturn-static-auth-secret-for-tests'

describe('ICE server configuration', () => {
  let app: FastifyInstance
  let owner: Session

  beforeAll(async () => {
    app = await createTestApp({
      DESKOS_ICE_STUN_URLS: 'stun:stun.l.google.com:19302',
      DESKOS_ICE_TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:443',
      DESKOS_ICE_TURN_SECRET: TURN_SECRET,
      DESKOS_ICE_TURN_REALM: 'deskos',
    })
    owner = await signupOwner(app, { tenantName: 'ICE Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('mints short-lived coturn credentials that verify against the shared secret', () => {
    const servers = buildIceServers(app.config.ice)
    const turn = servers.filter((server) => typeof server.urls === 'string' && server.urls.startsWith('turn'))
    expect(turn).toHaveLength(2)
    for (const server of turn) {
      expect(server.username).toMatch(/^\d+:deskos$/)
      expect(
        verifyTurnCredential(TURN_SECRET, server.username!, server.credential!),
      ).toBe(true)
    }
  })

  it('returns STUN plus TURN servers to an authenticated technician', async () => {
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'ice-box', hostname: 'ice-host', os: 'windows' },
    })
    const deviceId = enrol.json().device.id as string

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'ICE test' },
    })
    expect(created.statusCode).toBe(201)
    const sessionId = created.json().session.id as string

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}/ice`,
      headers: authHeaders(owner),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { iceServers: Array<{ urls: string; username?: string; credential?: string }> }
    expect(body.iceServers.some((server) => server.urls === 'stun:stun.l.google.com:19302')).toBe(true)
    const turn = body.iceServers.find((server) => server.urls === 'turn:turn.example.com:3478')
    expect(turn).toBeTruthy()
    expect(verifyTurnCredential(TURN_SECRET, turn!.username!, turn!.credential!)).toBe(true)
  })

  it('returns ICE servers to the enrolled agent for its own session', async () => {
    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'ice-agent-box', hostname: 'ice-agent-host', os: 'windows' },
    })
    const { id: deviceId } = enrol.json().device as { id: string }
    const deviceToken = enrol.json().deviceToken as string

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'ICE agent test' },
    })
    const sessionId = created.json().session.id as string

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agent/sessions/${sessionId}/ice`,
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { iceServers: Array<{ urls: string; username?: string; credential?: string }> }
    expect(body.iceServers.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects the technician ICE lookup for an unknown session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions/00000000-0000-0000-0000-000000000000/ice',
      headers: authHeaders(owner),
    })
    expect(res.statusCode).toBe(404)
  })
})
