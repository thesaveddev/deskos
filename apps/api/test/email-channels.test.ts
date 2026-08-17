import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, seedActiveMember, signupOwner, authHeaders } from './helpers.js'
import { encryptSecret, decryptSecret } from '../src/core/crypto.js'
import { listAllEnabledChannels } from '../src/modules/email/email.channels.js'
import { withTenant } from '../src/db/pool.js'

const EMAIL_KEY = 'unit-test-email-key-0123456789abcdef0123456789abcdef'

function channelPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Support Inbox',
    address: 'support@acme.example',
    imapHost: 'mail.acme.example',
    imapPort: 993,
    imapUser: 'support@acme.example',
    imapPass: 'hunter2-secret',
    imapTls: true,
    ...overrides,
  }
}

describe('email channels', () => {
  let app: FastifyInstance
  let ownerA: Awaited<ReturnType<typeof signupOwner>>
  let ownerB: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    ownerA = await signupOwner(app, { tenantName: 'Channels A' })
    ownerB = await signupOwner(app, { tenantName: 'Channels B' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates a channel and encrypts the IMAP password at rest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerA),
      payload: channelPayload(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeTruthy()

    const db = await withTenant(app.db, ownerA.tenantId!, (client) =>
      client.query('SELECT imap_pass_enc FROM email_channels WHERE id = $1', [body.id]),
    )
    const stored = db.rows[0].imap_pass_enc as string
    expect(stored).toMatch(/^v1:/)
    expect(stored).not.toContain('hunter2-secret')
    expect(decryptSecret(stored, EMAIL_KEY)).toBe('hunter2-secret')
  })

  it('lists channels with masked password', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerA),
    })
    expect(res.statusCode).toBe(200)
    const { channels } = res.json()
    expect(channels).toHaveLength(1)
    expect(channels[0].name).toBe('Support Inbox')
    expect(channels[0].imapUser).toBe('support@acme.example')
    expect(channels[0].hasPassword).toBe(true)
    expect(channels[0].passwordMasked).toMatch(/•/)
    expect(JSON.stringify(channels)).not.toContain('hunter2-secret')
  })

  it('enforces tenant isolation on channels', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerB),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().channels).toHaveLength(0)

    // Tenant B cannot update/delete Tenant A's channel
    const aChannel = (
      await app.inject({ method: 'GET', url: '/api/v1/email/channels', headers: authHeaders(ownerA) })
    ).json().channels[0]
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/email/channels/${aChannel.id}`,
      headers: authHeaders(ownerB),
      payload: { enabled: false },
    })
    expect(patch.statusCode).toBe(404)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/email/channels/${aChannel.id}`,
      headers: authHeaders(ownerB),
    })
    expect(del.statusCode).toBe(404)
  })

  it('updates a channel without losing the password', async () => {
    const aChannel = (
      await app.inject({ method: 'GET', url: '/api/v1/email/channels', headers: authHeaders(ownerA) })
    ).json().channels[0]

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/email/channels/${aChannel.id}`,
      headers: authHeaders(ownerA),
      payload: { name: 'Renamed Inbox', enabled: false },
    })
    expect(patch.statusCode).toBe(200)

    const db = await withTenant(app.db, ownerA.tenantId!, (client) =>
      client.query('SELECT name, imap_pass_enc, enabled FROM email_channels WHERE id = $1', [aChannel.id]),
    )
    expect(db.rows[0].name).toBe('Renamed Inbox')
    expect(db.rows[0].enabled).toBe(false)
    expect(decryptSecret(db.rows[0].imap_pass_enc as string, EMAIL_KEY)).toBe('hunter2-secret')

    // Password can be rotated on update
    const rotate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/email/channels/${aChannel.id}`,
      headers: authHeaders(ownerA),
      payload: { imapPass: 'new-secret-456', enabled: true },
    })
    expect(rotate.statusCode).toBe(200)
    const db2 = await withTenant(app.db, ownerA.tenantId!, (client) =>
      client.query('SELECT imap_pass_enc, enabled FROM email_channels WHERE id = $1', [aChannel.id]),
    )
    expect(decryptSecret(db2.rows[0].imap_pass_enc as string, EMAIL_KEY)).toBe('new-secret-456')
    expect(db2.rows[0].enabled).toBe(true)
  })

  it('deletes a channel', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerB),
      payload: channelPayload({ name: 'Temp', address: 'temp@acme.example' }),
    })
    const id = created.json().id

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/email/channels/${id}`,
      headers: authHeaders(ownerB),
    })
    expect(del.statusCode).toBe(200)

    const gone = await app.inject({ method: 'GET', url: '/api/v1/email/channels', headers: authHeaders(ownerB) })
    expect(gone.json().channels).toHaveLength(0)
  })

  it('requires settings.manage permission', async () => {
    const agent = await seedActiveMember(app, ownerA.tenantId!, 'agent')
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/email/channels',
      headers: authHeaders(agent),
    })
    expect(res.statusCode).toBe(403)
  })

  it('test-before-add endpoint rejects bad credentials with a clear error, not a 500', async () => {
    // Closed port on localhost fails fast and deterministically.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels/test',
      headers: authHeaders(ownerA),
      payload: {
        imapHost: '127.0.0.1',
        imapPort: 1,
        imapUser: 'x@example.com',
        imapPass: 'secret',
        imapTls: false,
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(false)
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })

  it('test-before-add endpoint requires settings.manage and validates payload', async () => {
    const agent = await seedActiveMember(app, ownerA.tenantId!, 'agent')
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels/test',
      headers: authHeaders(agent),
      payload: { imapHost: 'mail.example.com', imapPort: 993, imapUser: 'u', imapPass: 'p', imapTls: true },
    })
    expect(denied.statusCode).toBe(403)

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels/test',
      headers: authHeaders(ownerA),
      payload: { imapHost: 'mail.example.com', imapPort: 0, imapUser: 'u', imapPass: 'p', imapTls: true },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('trims whitespace from channel inputs on create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerB),
      payload: channelPayload({
        name: '  Padded Inbox  ',
        imapHost: '  mail.padded.example  ',
        imapUser: '  support@acme.example  ',
        address: '  support@acme.example  ',
      }),
    })
    expect(res.statusCode).toBe(201)
    const id = res.json().id
    const db = await withTenant(app.db, ownerB.tenantId!, (client) =>
      client.query('SELECT name, imap_host, imap_user, address FROM email_channels WHERE id = $1', [id]),
    )
    expect(db.rows[0].name).toBe('Padded Inbox')
    expect(db.rows[0].imap_host).toBe('mail.padded.example')
    expect(db.rows[0].imap_user).toBe('support@acme.example')
    expect(db.rows[0].address).toBe('support@acme.example')
  })

  it('listAllEnabledChannels returns enabled channels across tenants (platform-level)', async () => {
    // Owner A's channel is enabled (from the rotate step); seed one on B.
    await app.inject({
      method: 'POST',
      url: '/api/v1/email/channels',
      headers: authHeaders(ownerB),
      payload: channelPayload({ name: 'B Inbox', address: 'support@b.example', enabled: true }),
    })
    const all = await listAllEnabledChannels(app.db)
    const tenants = all.filter((t) => t.tenantId === ownerA.tenantId || t.tenantId === ownerB.tenantId)
    expect(tenants.length).toBe(2)
    const flattened = tenants.flatMap((t) => t.channels.map((c) => c.tenantId))
    expect(flattened).toEqual(expect.arrayContaining([ownerA.tenantId!, ownerB.tenantId!]))
  })

  it('encrypt/decrypt round-trips and rejects tampering', async () => {
    const enc = encryptSecret('p@ss w0rd', EMAIL_KEY)
    expect(enc).toMatch(/^v1:/)
    expect(decryptSecret(enc, EMAIL_KEY)).toBe('p@ss w0rd')
    expect(() => decryptSecret(enc, 'wrong-key-00000000000000000000000000000000')).toThrow()
  })
})
