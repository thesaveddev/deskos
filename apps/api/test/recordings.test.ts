import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner, type Session } from './helpers.js'
import { withTenant } from '../src/db/pool.js'

function multipartBody(boundary: string, content: string) {
  return [
    `--${boundary}`,
    'Content-Disposition: form-data; name="recording"; filename="session.webm"',
    'Content-Type: video/webm',
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

async function enrolDevice(app: FastifyInstance, owner: Session, name: string): Promise<string> {
  const rotate = await app.inject({
    method: 'POST',
    url: '/api/v1/devices/enrol-token/rotate',
    headers: authHeaders(owner),
  })
  const enrol = await app.inject({
    method: 'POST',
    url: '/api/v1/agent/enrol',
    payload: { token: rotate.json().token, name, hostname: `${name}-host`, os: 'windows' },
  })
  return enrol.json().device.id as string
}

async function createSession(app: FastifyInstance, owner: Session, deviceId: string, recordingMode: 'video' | 'metadata'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/sessions',
    headers: authHeaders(owner),
    payload: { deviceId, permissions: ['view_screen'], recordingMode, recordingRetentionDays: 30 },
  })
  return res.json().session.id as string
}

describe('session recordings', () => {
  let app: FastifyInstance
  let owner: Session
  let videoSessionId: string
  let metaSessionId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Recording Org' })
    const deviceId = await enrolDevice(app, owner, 'recording-box')
    videoSessionId = await createSession(app, owner, deviceId, 'video')
    metaSessionId = await createSession(app, owner, deviceId, 'metadata')
  })

  afterAll(async () => {
    await app.close()
  })

  it('uploads, lists, and downloads a recording for a video session', async () => {
    const boundary = 'reydesk-recording-boundary'
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${videoSessionId}/recordings?durationSec=42`,
      headers: { ...authHeaders(owner), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'WEBM-FAKE-CONTENT'),
    })
    expect(upload.statusCode).toBe(201)
    expect(upload.json().recording.duration_sec).toBe(42)

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${videoSessionId}/recordings`,
      headers: authHeaders(owner),
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().recordings).toHaveLength(1)
    const recordingId = list.json().recordings[0].id as string

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${videoSessionId}/recordings/${recordingId}`,
      headers: authHeaders(owner),
    })
    expect(download.statusCode).toBe(200)
    expect(download.body).toContain('WEBM-FAKE-CONTENT')
    expect(download.headers['content-type']).toContain('video/webm')
  })

  it('rejects recording upload when the session does not permit video recording', async () => {
    const boundary = 'reydesk-recording-denied'
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${metaSessionId}/recordings`,
      headers: { ...authHeaders(owner), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'SHOULD-NOT-STORE'),
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('recording_not_enabled')
  })

  it('purges expired recordings and blocks their download', async () => {
    const boundary = 'reydesk-recording-expiry'
    const upload = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${videoSessionId}/recordings`,
      headers: { ...authHeaders(owner), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, 'EXPIRED-CONTENT'),
    })
    const recordingId = upload.json().recording.id as string

    // Force the row past its retention window.
    await withTenant(app.db, owner.tenantId!, (client) =>
      client.query("UPDATE session_recordings SET expires_at = now() - interval '1 minute' WHERE id = $1", [recordingId]),
    )

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${videoSessionId}/recordings`,
      headers: authHeaders(owner),
    })
    expect(list.json().recordings.map((recording: { id: string }) => recording.id)).not.toContain(recordingId)

    const download = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${videoSessionId}/recordings/${recordingId}`,
      headers: authHeaders(owner),
    })
    expect(download.statusCode).toBe(404)
  })
})
