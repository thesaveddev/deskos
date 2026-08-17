import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

function multipartBody(boundary: string, filename: string, content: string, mime = 'text/plain') {
  return [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${mime}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

describe('attachments', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let stranger: Awaited<ReturnType<typeof signupOwner>>
  let ticketId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'Attach Org' })
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    stranger = await signupOwner(app, { tenantName: 'Other Attach Org' })
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Ticket with files' },
    })
    ticketId = created.json().ticket.id
  })

  afterAll(async () => {
    await app.close()
  })

  let attachmentId: string

  it('uploads a file and records it', async () => {
    const boundary = 'deskosboundary123'
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: {
        ...authHeaders(owner),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, 'diag notes.txt', 'hello attachment world'),
    })
    expect(res.statusCode).toBe(201)
    const attachment = res.json().attachment
    attachmentId = attachment.id
    expect(attachment.filename).toBe('diag notes.txt')
    expect(attachment.size_bytes).toBe('hello attachment world'.length)
    expect(attachment.mime).toBe('text/plain')
  })

  it('lists attachments for the ticket', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: authHeaders(owner),
    })
    expect(res.statusCode).toBe(200)
    const list = res.json().attachments
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(attachmentId)
    expect(list[0].uploader_name).toBe('Test Owner')
  })

  it('downloads the file with the original content', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: authHeaders(owner),
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/plain')
    expect(res.headers['content-disposition']).toContain('diag notes.txt')
    expect(res.body).toBe('hello attachment world')
  })

  it('denies cross-tenant download via RLS', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${attachmentId}`,
      headers: authHeaders(stranger),
    })
    expect(res.statusCode).toBe(404)
  })

  it('denies upload to end_user', async () => {
    const boundary = 'deskosboundary456'
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: {
        ...authHeaders(endUser),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, 'x.txt', 'nope'),
    })
    expect(res.statusCode).toBe(403)
  })

  it('sanitizes dangerous filenames', async () => {
    const boundary = 'deskosboundary789'
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/tickets/${ticketId}/attachments`,
      headers: {
        ...authHeaders(owner),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, '../../etc/passwd', 'payload'),
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().attachment.filename).not.toContain('/')
    expect(res.json().attachment.filename).not.toContain('..')
  })
})
