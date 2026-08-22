import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

function multipartMessage(boundary: string, body: string, filename: string, content: string, mime = 'text/plain') {
  return [
    `--${boundary}`,
    'Content-Disposition: form-data; name="body"',
    '',
    body,
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mime}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

describe('team chat', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let engineer: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let roomId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Chat Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    engineer = await seedActiveMember(app, owner.tenantId!, 'desktop_engineer')
    foreign = await signupOwner(app, { tenantName: 'Chat Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('denies end users and allows analysts to read chat', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const allowed = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(analyst) })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().rooms).toEqual([])
  })

  it('creates rooms and rejects duplicate names', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'General' } })
    expect(created.statusCode).toBe(201)
    roomId = created.json().room.id

    const dup = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'General' } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('duplicate_room')
  })

  it('limits private team rooms to members and organization managers', async () => {
    const team = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: 'Desktop Support', memberIds: [analyst.userId], createChat: true },
    })
    expect(team.statusCode).toBe(201)
    const privateRoomId = team.json().team.chat_room_id as string

    const memberRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(analyst) })
    expect(memberRooms.json().rooms.some((room: { id: string }) => room.id === privateRoomId)).toBe(true)

    const nonMemberRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(engineer) })
    expect(nonMemberRooms.json().rooms.some((room: { id: string }) => room.id === privateRoomId)).toBe(false)

    const denied = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${privateRoomId}/messages`, headers: authHeaders(engineer) })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('permission_denied')
    expect(denied.json().error.denied_reason).toBe('team_chat_membership_required')
  })

  it('manages standalone room members and restricts access after the first addition', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'Incident bridge' } })
    expect(created.statusCode).toBe(201)
    const standaloneRoomId = created.json().room.id as string

    const candidates = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${standaloneRoomId}/member-candidates?q=analyst`, headers: authHeaders(owner) })
    expect(candidates.statusCode).toBe(200)
    expect(candidates.json().members.some((member: { user_id: string }) => member.user_id === analyst.userId)).toBe(true)

    const added = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${standaloneRoomId}/members`, headers: authHeaders(owner), payload: { userId: analyst.userId } })
    expect(added.statusCode).toBe(201)

    const roomMembers = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${standaloneRoomId}/members`, headers: authHeaders(analyst) })
    expect(roomMembers.statusCode).toBe(200)
    expect(roomMembers.json().room.access_mode).toBe('restricted')
    expect(roomMembers.json().members.some((member: { user_id: string; source: string }) => member.user_id === analyst.userId && member.source === 'direct')).toBe(true)

    const hidden = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(engineer) })
    expect(hidden.json().rooms.some((room: { id: string }) => room.id === standaloneRoomId)).toBe(false)
    const denied = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${standaloneRoomId}/messages`, headers: authHeaders(engineer) })
    expect(denied.statusCode).toBe(403)

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/chat/rooms/${standaloneRoomId}/members/${analyst.userId}`, headers: authHeaders(owner) })
    expect(removed.statusCode).toBe(200)
    const openAgain = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${standaloneRoomId}/members`, headers: authHeaders(engineer) })
    expect(openAgain.statusCode).toBe(200)
    expect(openAgain.json().room.access_mode).toBe('organization')
  })

  it('keeps team room membership managed by the team roster', async () => {
    const team = await app.inject({
      method: 'POST',
      url: '/api/v1/teams',
      headers: authHeaders(owner),
      payload: { name: 'Network Operations', memberIds: [analyst.userId], createChat: true },
    })
    const teamRoomId = team.json().team.chat_room_id as string
    const add = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${teamRoomId}/members`, headers: authHeaders(owner), payload: { userId: engineer.userId } })
    expect(add.statusCode).toBe(409)
    expect(add.json().error.code).toBe('team_chat_membership_managed_by_team')
    const members = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${teamRoomId}/members`, headers: authHeaders(owner) })
    expect(members.statusCode).toBe(200)
    expect(members.json().room.access_mode).toBe('team')
    expect(members.json().members.some((member: { user_id: string }) => member.user_id === analyst.userId)).toBe(true)
  })

  it('posts and lists messages with sender info', async () => {
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst), payload: { body: 'Hello team' } })
    expect(sent.statusCode).toBe(201)
    expect(sent.json().message.body).toBe('Hello team')

    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const messages = list.json().messages as Array<{ body: string; sender_name: string }>
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Hello team')
    expect(messages[0].sender_name).toBe('analyst user')
  })

  it('shares a file with a message and protects its download by room access', async () => {
    const boundary = 'chat-file-boundary'
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/chat/rooms/${roomId}/messages`,
      headers: { ...authHeaders(analyst), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartMessage(boundary, 'Here are the diagnostics.', 'diagnostics.txt', 'cpu=22\nmem=41'),
    })
    expect(sent.statusCode).toBe(201)
    const attachment = sent.json().message.attachments[0]
    expect(attachment.filename).toBe('diagnostics.txt')
    expect(Number(attachment.size_bytes)).toBe(13)

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/attachments/${attachment.id}`,
      headers: authHeaders(owner),
    })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-disposition']).toContain('diagnostics.txt')
    expect(download.body).toBe('cpu=22\nmem=41')

    const foreignDownload = await app.inject({
      method: 'GET',
      url: `/api/v1/chat/attachments/${attachment.id}`,
      headers: authHeaders(foreign),
    })
    expect(foreignDownload.statusCode).toBe(404)
  })

  it('rejects blank or oversized message bodies', async () => {
    const blank = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(owner), payload: { body: '   ' } })
    expect(blank.statusCode).toBe(400)
  })

  it('isolates rooms and messages between tenants', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(foreign) })
    expect(list.statusCode).toBe(404)

    const foreignRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(foreign) })
    expect(foreignRooms.json().rooms).toEqual([])
  })
})
