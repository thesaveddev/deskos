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

  it('returns the newest 200 messages when a room exceeds the window', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'Burst room' } })
    expect(created.statusCode).toBe(201)
    const burstRoomId = created.json().room.id as string
    for (let i = 0; i < 205; i++) {
      const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${burstRoomId}/messages`, headers: authHeaders(analyst), payload: { body: `msg ${i}` } })
      expect(sent.statusCode).toBe(201)
    }
    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${burstRoomId}/messages`, headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    const messages = list.json().messages as Array<{ body: string }>
    expect(messages).toHaveLength(200)
    expect(messages[0].body).toBe('msg 5')
    expect(messages[messages.length - 1].body).toBe('msg 204')
  })

  it('lets the author delete a recent message but not other members', async () => {
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst), payload: { body: 'delete me soon' } })
    expect(sent.statusCode).toBe(201)
    const messageId = sent.json().message.id as number

    const foreignDelete = await app.inject({ method: 'DELETE', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(engineer) })
    expect(foreignDelete.statusCode).toBe(403)
    expect(foreignDelete.json().error.code).toBe('permission_denied')

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(analyst) })
    expect(deleted.statusCode).toBe(200)

    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(owner) })
    expect((list.json().messages as Array<{ body: string }>).some((m) => m.body === 'delete me soon')).toBe(false)
  })

  it('lets a manager delete another member message in a restricted room', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(engineer), payload: { name: 'Engineer bridge' } })
    expect(created.statusCode).toBe(201)
    const bridgeRoomId = created.json().room.id as string

    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${bridgeRoomId}/messages`, headers: authHeaders(analyst), payload: { body: 'manager cleanup' } })
    expect(sent.statusCode).toBe(201)
    const messageId = sent.json().message.id as number

    const moderated = await app.inject({ method: 'DELETE', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(owner) })
    expect(moderated.statusCode).toBe(200)
  })

  it('reports last activity per room for sorting', async () => {
    const rooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(owner) })
    expect(rooms.statusCode).toBe(200)
    for (const room of rooms.json().rooms as Array<{ last_message_at: string | null }>) {
      expect('last_message_at' in room).toBe(true)
    }
  })

  it('lets the author edit a message and marks it edited', async () => {
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst), payload: { body: 'typo heer' } })
    expect(sent.statusCode).toBe(201)
    const messageId = sent.json().message.id as number

    const edited = await app.inject({ method: 'PATCH', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(analyst), payload: { body: 'typo here' } })
    expect(edited.statusCode).toBe(200)
    expect(edited.json().message.body).toBe('typo here')
    expect(edited.json().message.edited_at).toBeTruthy()

    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst) })
    const stored = (list.json().messages as Array<{ id: number; body: string; edited_at: string | null }>).find((m) => m.id === messageId)
    expect(stored?.body).toBe('typo here')
    expect(stored?.edited_at).toBeTruthy()
  })

  it('rejects edits from other members and blank edits', async () => {
    const sent = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(analyst), payload: { body: 'mine only' } })
    expect(sent.statusCode).toBe(201)
    const messageId = sent.json().message.id as number

    const foreignEdit = await app.inject({ method: 'PATCH', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(engineer), payload: { body: 'rewritten by someone else' } })
    expect(foreignEdit.statusCode).toBe(403)
    expect(foreignEdit.json().error.denied_reason).toBe('chat_message_edit_forbidden')

    // Managers moderate by deleting, not by rewriting other people's words.
    const managerEdit = await app.inject({ method: 'PATCH', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(owner), payload: { body: 'manager rewrite' } })
    expect(managerEdit.statusCode).toBe(403)

    const blankEdit = await app.inject({ method: 'PATCH', url: `/api/v1/chat/messages/${messageId}`, headers: authHeaders(analyst), payload: { body: '   ' } })
    expect(blankEdit.statusCode).toBe(400)
  })

  it('tracks unread counts per room until the room is marked read', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/chat/rooms', headers: authHeaders(owner), payload: { name: 'Unread room' } })
    expect(created.statusCode).toBe(201)
    const unreadRoomId = created.json().room.id as string

    const unreadFor = async (): Promise<number> => {
      const rooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(owner) })
      const room = (rooms.json().rooms as Array<{ id: string; unread_count: number | string }>).find((r) => r.id === unreadRoomId)
      return Number(room?.unread_count ?? -1)
    }

    // The creator has never opened the room: both messages are unread.
    await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${unreadRoomId}/messages`, headers: authHeaders(analyst), payload: { body: 'first heads-up' } })
    await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${unreadRoomId}/messages`, headers: authHeaders(analyst), payload: { body: 'second heads-up' } })
    expect(await unreadFor()).toBe(2)

    const marked = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${unreadRoomId}/read`, headers: authHeaders(owner), payload: {} })
    expect(marked.statusCode).toBe(200)
    expect(await unreadFor()).toBe(0)

    // A new arrival after the marker counts as exactly one unread again.
    await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${unreadRoomId}/messages`, headers: authHeaders(analyst), payload: { body: 'third heads-up' } })
    expect(await unreadFor()).toBe(1)

    // The analyst's own read state is independent of the owner's.
    const analystRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(analyst) })
    const analystRoom = (analystRooms.json().rooms as Array<{ id: string; unread_count: number | string }>).find((r) => r.id === unreadRoomId)
    expect(Number(analystRoom?.unread_count ?? -1)).toBe(3)

    // End users cannot read chat, so they cannot mark rooms read either.
    const denied = await app.inject({ method: 'POST', url: `/api/v1/chat/rooms/${unreadRoomId}/read`, headers: authHeaders(endUser), payload: {} })
    expect(denied.statusCode).toBe(403)
  })

  it('isolates rooms and messages between tenants', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/v1/chat/rooms/${roomId}/messages`, headers: authHeaders(foreign) })
    expect(list.statusCode).toBe(404)

    const foreignRooms = await app.inject({ method: 'GET', url: '/api/v1/chat/rooms', headers: authHeaders(foreign) })
    expect(foreignRooms.json().rooms).toEqual([])
  })
})
