import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner, type Session } from './helpers.js'

describe('remote session control plane', () => {
  let app: FastifyInstance
  let owner: Session
  let otherOwner: Session
  let deviceId: string
  let deviceToken: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Remote Org' })
    otherOwner = await signupOwner(app, { tenantName: 'Other Remote Org' })

    const rotate = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/enrol-token/rotate',
      headers: authHeaders(owner),
    })
    expect(rotate.statusCode).toBe(201)
    const enrol = await app.inject({
      method: 'POST',
      url: '/api/v1/agent/enrol',
      payload: { token: rotate.json().token, name: 'remote-box', hostname: 'remote-host', os: 'windows' },
    })
    expect(enrol.statusCode).toBe(201)
    deviceId = enrol.json().device.id
    deviceToken = enrol.json().deviceToken
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates an attended session with a short-lived technician broker ticket', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: {
        deviceId,
        type: 'attended',
        permissions: ['view_screen', 'control_input'],
        reason: 'Troubleshoot display issue',
      },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().session.state).toBe('consent_pending')
    expect(res.json().session.device_id).toBe(deviceId)
    expect(res.json().joinToken.split('.')).toHaveLength(2)
  })

  it('can issue a fresh technician join ticket when reopening the console', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Open console test' },
    })
    const sessionId = created.json().session.id as string
    const joined = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/join`,
      headers: authHeaders(owner),
      payload: {},
    })
    expect(joined.statusCode).toBe(200)
    expect(joined.json().joinToken.split('.')).toHaveLength(2)
    expect(joined.json().session.id).toBe(sessionId)
  })

  it('requires the correct remote permission and a reason for unattended access', async () => {
    const analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, type: 'unattended', permissions: ['view_screen'] },
    })
    expect(denied.statusCode).toBe(403)

    const controlDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, permissions: ['view_screen', 'control_input'], reason: 'Attempt input access' },
    })
    expect(controlDenied.statusCode).toBe(403)

    const clipboardDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, permissions: ['view_screen', 'clipboard'], reason: 'Attempt clipboard access' },
    })
    expect(clipboardDenied.statusCode).toBe(403)

    const clipboardAllowed = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'clipboard'], reason: 'Validate clipboard access' },
    })
    expect(clipboardAllowed.statusCode).toBe(201)

    const terminalDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, permissions: ['view_screen', 'terminal', 'elevation'], reason: 'Attempt terminal access' },
    })
    expect(terminalDenied.statusCode).toBe(403)

    const terminalNeedsElevation = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'terminal'], reason: 'Terminal policy check' },
    })
    expect(terminalNeedsElevation.statusCode).toBe(400)

    const terminalAllowed = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'terminal', 'elevation'], reason: 'Validate terminal access' },
    })
    expect(terminalAllowed.statusCode).toBe(201)

    const filesDenied = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(analyst),
      payload: { deviceId, permissions: ['view_screen', 'file_transfer'], reason: 'Attempt file transfer access' },
    })
    expect(filesDenied.statusCode).toBe(403)

    const filesAllowed = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'file_transfer'], reason: 'Validate file transfer access' },
    })
    expect(filesAllowed.statusCode).toBe(201)

    const missingReason = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, type: 'unattended', permissions: ['view_screen'] },
    })
    expect(missingReason.statusCode).toBe(400)
  })

  it('lets the agent discover, grant consent, and report active state', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Check endpoint health' },
    })
    const sessionId = created.json().session.id as string

    const pending = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/sessions',
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(pending.statusCode).toBe(200)
    expect(pending.json().sessions.some((session: { id: string }) => session.id === sessionId)).toBe(true)

    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })
    expect(consent.statusCode).toBe(200)
    expect(consent.json().session.state).toBe('connecting')
    expect(consent.json().joinToken.split('.')).toHaveLength(2)

    const active = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/state`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { state: 'active' },
    })
    expect(active.statusCode).toBe(200)
    expect(active.json().session.started_at).toBeTruthy()

    const diagnostic = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/diagnostics`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { event: 'screen.frame_encoded', reason: 'bytes=1234' },
    })
    expect(diagnostic.statusCode).toBe(201)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().session.state).toBe('active')
    expect(detail.json().events.map((event: { event: string }) => event.event)).toContain('session.consent_granted')
    expect(detail.json().events.map((event: { event: string }) => event.event)).toContain('session.active')
    expect(detail.json().events.map((event: { event: string }) => event.event)).toContain('session.screen.frame_encoded')
  })

  it('lets the endpoint accept screen sharing while declining elevated access', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'terminal', 'elevation', 'system_manage'], reason: 'Elevation prompt test' },
    })
    const sessionId = created.json().session.id as string

    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true, permissions: ['view_screen'] },
    })
    expect(consent.statusCode).toBe(200)
    expect(consent.json().session.state).toBe('connecting')
    expect(consent.json().session.permissions).toEqual(['view_screen'])
    expect(consent.json().joinToken.split('.')).toHaveLength(2)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: authHeaders(owner) })
    const events = detail.json().events.map((event: { event: string }) => event.event)
    expect(events).toContain('session.elevation_denied')
    expect(detail.json().session.permissions).toEqual(['view_screen'])
  })

  it('ignores permissions the session never requested when reducing consent', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Consent subset validation' },
    })
    const sessionId = created.json().session.id as string

    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true, permissions: ['view_screen', 'clipboard'] },
    })
    expect(consent.statusCode).toBe(200)
    expect(consent.json().session.permissions).toEqual(['view_screen'])
  })

  it('issues a fresh agent ticket for reconnecting sessions and blocks ended sessions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'reboot_reconnect'], reason: 'Reconnect test' },
    })
    const sessionId = created.json().session.id as string
    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })
    expect(consent.statusCode).toBe(200)
    const active = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/state`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { state: 'active' },
    })
    expect(active.statusCode).toBe(200)
    const startupSessions = await app.inject({
      method: 'GET',
      url: '/api/v1/agent/sessions',
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(startupSessions.statusCode).toBe(200)
    expect(startupSessions.json().sessions.some((session: { id: string; state: string }) => session.id === sessionId && session.state === 'active')).toBe(true)

    const reconnect = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/reconnect`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    })
    expect(reconnect.statusCode).toBe(200)
    expect(reconnect.json().session.state).toBe('reconnecting')
    expect(reconnect.json().joinToken.split('.')).toHaveLength(2)

    const end = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/end`,
      headers: authHeaders(owner),
    })
    expect(end.statusCode).toBe(200)
    const afterEnd = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/reconnect`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    })
    expect(afterEnd.statusCode).toBe(409)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: authHeaders(owner),
    })
    expect(detail.json().events.map((event: { event: string }) => event.event)).toContain('session.agent_reconnect_ticket_issued')
  })

  it('allows the enrolled endpoint to invoke its local session kill switch', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Endpoint stop test' },
    })
    const sessionId = created.json().session.id as string
    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })
    expect(consent.statusCode).toBe(200)
    const ended = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/end`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    })
    expect(ended.statusCode).toBe(200)
    expect(ended.json().session.state).toBe('ended')
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/end`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {},
    })
    expect(repeated.statusCode).toBe(200)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: authHeaders(owner),
    })
    expect(detail.json().events.map((event: { event: string }) => event.event)).toContain('session.agent_ended')
  })

  it('records agent input outcomes without storing sensitive input payloads', async () => {
    const controlled = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen', 'control_input'], reason: 'Audit input path' },
    })
    const controlledId = controlled.json().session.id as string
    const consent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${controlledId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })
    expect(consent.statusCode).toBe(200)
    const active = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${controlledId}/state`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { state: 'active' },
    })
    expect(active.statusCode).toBe(200)

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${controlledId}/events`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { outcome: 'accepted', action: 'click', reason: 'applied' },
    })
    expect(accepted.statusCode).toBe(201)

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${controlledId}/events`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { outcome: 'rejected', action: 'keydown', reason: 'invalid_payload' },
    })
    expect(rejected.statusCode).toBe(201)

    const viewOnly = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Reject forged input audit' },
    })
    const viewOnlyId = viewOnly.json().session.id as string
    const viewOnlyConsent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${viewOnlyId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })
    expect(viewOnlyConsent.statusCode).toBe(200)
    const viewOnlyActive = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${viewOnlyId}/state`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { state: 'active' },
    })
    expect(viewOnlyActive.statusCode).toBe(200)
    const viewOnlyAccepted = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${viewOnlyId}/events`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { outcome: 'accepted', action: 'pointermove', reason: 'applied' },
    })
    expect(viewOnlyAccepted.statusCode).toBe(403)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${controlledId}`,
      headers: authHeaders(owner),
    })
    expect(detail.statusCode).toBe(200)
    const inputEvents = detail.json().events.filter((event: { event: string }) => event.event.startsWith('session.input.'))
    expect(inputEvents.map((event: { event: string }) => event.event)).toEqual([
      'session.input.accepted',
      'session.input.rejected',
    ])
    expect(inputEvents[0].payload).toEqual({ action: 'click', reason: 'applied' })
    for (const event of inputEvents) {
      expect(Object.keys(event.payload)).not.toContain('x')
      expect(Object.keys(event.payload)).not.toContain('y')
    }
  })

  it('denies consent and prevents cross-tenant session access', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Validate consent path' },
    })
    const sessionId = created.json().session.id as string
    const denied = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: false },
    })
    expect(denied.statusCode).toBe(200)
    expect(denied.json().session.state).toBe('denied')

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${sessionId}`,
      headers: authHeaders(otherOwner),
    })
    expect(other.statusCode).toBe(404)
  })

  it('ends a session idempotently', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'End-session test' },
    })
    const sessionId = created.json().session.id as string
    const first = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })
    const second = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })
    expect(first.statusCode).toBe(200)
    expect(first.json().session.state).toBe('ended')
    expect(second.statusCode).toBe(200)
    expect(second.json().session.state).toBe('ended')
  })

  it('persists and lists session chat from technicians and the agent', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Chat test' },
    })
    const sessionId = created.json().session.id as string

    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${sessionId}/messages`,
      headers: authHeaders(owner),
      payload: { body: 'Hello from the technician' },
    })
    expect(sent.statusCode).toBe(201)
    expect(sent.json().message.sender_type).toBe('technician')
    expect(sent.json().message.body).toBe('Hello from the technician')

    await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/consent`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { granted: true },
    })

    const agentSent = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/messages`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { body: 'Hello from the endpoint' },
    })
    expect(agentSent.statusCode).toBe(201)
    expect(agentSent.json().message.sender_type).toBe('agent')

    const listed = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/messages`, headers: authHeaders(owner) })
    expect(listed.statusCode).toBe(200)
    const bodies = listed.json().messages.map((message: { body: string }) => message.body)
    expect(bodies).toContain('Hello from the technician')
    expect(bodies).toContain('Hello from the endpoint')

    const detail = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}`, headers: authHeaders(owner) })
    const chatEvents = detail.json().events.filter((event: { event: string }) => event.event === 'session.chat.sent')
    expect(chatEvents.length).toBe(2)
  })

  it('rejects chat on an ended session and keeps chat tenant-isolated', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Chat isolation test' },
    })
    const sessionId = created.json().session.id as string

    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/messages`, headers: authHeaders(owner), payload: { body: 'first' } })
    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })

    const afterEnd = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/messages`, headers: authHeaders(owner), payload: { body: 'too late' } })
    expect(afterEnd.statusCode).toBe(409)

    const otherList = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/messages`, headers: authHeaders(otherOwner) })
    expect(otherList.statusCode).toBe(404)
  })

  it('seeds the owner, invites a tenant technician, and transfers ownership', async () => {
    const member = await seedActiveMember(app, owner.tenantId!, 'desktop_engineer')
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Collaboration test' },
    })
    const sessionId = created.json().session.id as string

    const participants = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/participants`, headers: authHeaders(owner) })
    expect(participants.statusCode).toBe(200)
    expect(participants.json().participants.length).toBe(1)
    expect(participants.json().participants[0].role).toBe('owner')
    expect(participants.json().participants[0].user_id).toBe(owner.userId)

    const selfInvite = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/invite`, headers: authHeaders(owner), payload: { userId: owner.userId } })
    expect(selfInvite.statusCode).toBe(400)

    const invite = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/invite`, headers: authHeaders(owner), payload: { userId: member.userId, role: 'observer' } })
    expect(invite.statusCode).toBe(201)
    expect(invite.json().participant.role).toBe('observer')

    const nonOwnerTransfer = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/transfer`, headers: authHeaders(member), payload: { userId: member.userId } })
    expect(nonOwnerTransfer.statusCode).toBe(403)

    const transfer = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/transfer`, headers: authHeaders(owner), payload: { userId: member.userId } })
    expect(transfer.statusCode).toBe(200)
    expect(transfer.json().participant.role).toBe('owner')

    const after = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/participants`, headers: authHeaders(owner) })
    const roles = after.json().participants.map((participant: { user_id: string; role: string }) => [participant.user_id, participant.role])
    expect(roles).toContainEqual([member.userId, 'owner'])
    expect(roles).toContainEqual([owner.userId, 'technician'])
  })

  it('refuses to invite a user outside the tenant', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Cross-tenant invite test' },
    })
    const sessionId = created.json().session.id as string
    const invite = await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/invite`, headers: authHeaders(owner), payload: { userId: otherOwner.userId } })
    expect(invite.statusCode).toBe(404)
  })

  it('rejects double consent and invalid agent state transitions', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'State machine test' },
    })
    const sessionId = created.json().session.id as string

    const first = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/consent`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { granted: true } })
    expect(first.statusCode).toBe(200)
    expect(first.json().session.state).toBe('connecting')

    const replay = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/consent`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { granted: true } })
    expect(replay.statusCode).toBe(409)

    const bogus = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/state`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'hacked' } })
    expect(bogus.statusCode).toBe(400)
  })

  it('rejects agent audit events after the session ends', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Ended audit test' },
    })
    const sessionId = created.json().session.id as string
    await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/consent`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { granted: true } })
    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })

    const afterEnd = await app.inject({
      method: 'POST',
      url: `/api/v1/agent/sessions/${sessionId}/events`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { outcome: 'accepted', action: 'click', reason: 'applied' },
    })
    expect(afterEnd.statusCode).toBe(409)
  })

  it('mirrors session lifecycle into the linked ticket timeline', async () => {
    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Session timeline ticket', description: 'linked session test' },
    })
    const ticketId = ticketRes.json().ticket.id as string

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, ticketId, permissions: ['view_screen'], reason: 'Ticket timeline test' },
    })
    const sessionId = created.json().session.id as string

    await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/consent`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { granted: true } })
    await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/state`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'active' } })
    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: authHeaders(owner) })
    expect(detail.statusCode).toBe(200)
    const events = detail.json().threads
      .filter((thread: { kind: string }) => thread.kind === 'session_record')
      .map((thread: { meta: { event?: string } }) => thread.meta?.event)
    expect(events).toContain('session.created')
    expect(events).toContain('session.consent_granted')
    expect(events).toContain('session.active')
    expect(events).toContain('session.ended')
  })

  it('defaults new sessions to metadata recording with a 30-day retention', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], reason: 'Recording defaults test' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().session.recording_mode).toBe('metadata')
    expect(created.json().session.recording_retention_days).toBe(30)
  })

  it('accepts explicit recording policy and rejects invalid values', async () => {
    const video = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], recordingMode: 'video', recordingRetentionDays: 90, reason: 'Video recording test' },
    })
    expect(video.statusCode).toBe(201)
    expect(video.json().session.recording_mode).toBe('video')
    expect(video.json().session.recording_retention_days).toBe(90)

    const badMode = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], recordingMode: 'all' },
    })
    expect(badMode.statusCode).toBe(400)

    const badRetention = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], recordingRetentionDays: 0 },
    })
    expect(badRetention.statusCode).toBe(400)
  })

  it('records agent recording lifecycle events and rejects them after the session ends', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: authHeaders(owner),
      payload: { deviceId, permissions: ['view_screen'], recordingMode: 'video', reason: 'Recording lifecycle test' },
    })
    const sessionId = created.json().session.id as string
    await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/consent`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { granted: true } })
    await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/state`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'active' } })

    const started = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/recording`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'recording' } })
    expect(started.statusCode).toBe(201)
    expect(started.json().recorded).toBe(true)

    const failed = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/recording`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'failed', reason: 'encoder unavailable' } })
    expect(failed.statusCode).toBe(201)

    const bogus = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/recording`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'paused' } })
    expect(bogus.statusCode).toBe(400)

    await app.inject({ method: 'POST', url: `/api/v1/sessions/${sessionId}/end`, headers: authHeaders(owner) })
    const afterEnd = await app.inject({ method: 'POST', url: `/api/v1/agent/sessions/${sessionId}/recording`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { state: 'stopped' } })
    expect(afterEnd.statusCode).toBe(409)
  })
})
