import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner } from './helpers.js'
import { processRawEmail } from '../src/modules/email/email.service.js'
import { withTenant } from '../src/db/pool.js'

function rawEmail(opts: { from?: string; subject: string; body: string; messageId?: string }): string {
  return [
    `From: ${opts.from ?? 'Jane Doe <jane@example.com>'}`,
    'To: support@reydesk.com',
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId ?? `<msg-${Math.random().toString(36).slice(2)}@example.com>`}`,
    'Date: Tue, 12 Aug 2025 10:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
    '',
  ].join('\r\n')
}

describe('email-to-ticket', () => {
  let app: FastifyInstance
  let tenantId: string

  beforeAll(async () => {
    app = await createTestApp()
    const owner = await signupOwner(app, { tenantName: 'Email Org' })
    tenantId = owner.tenantId!
  })

  afterAll(async () => {
    await app.close()
  })

  it('creates a ticket + requester from an inbound email', async () => {
    const result = await processRawEmail(
      app.db,
      rawEmail({ subject: 'Monitor keeps going black', body: 'It happens every hour.' }),
      { tenantId },
    )
    expect(result.action).toBe('created')
    expect(result.ticketNumber).toBeGreaterThanOrEqual(1)

    const ticket = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT * FROM tickets WHERE number = $1', [result.ticketNumber]),
    )
    expect(ticket.rows[0].source).toBe('email')
    expect(ticket.rows[0].status).toBe('new')
    expect(ticket.rows[0].priority).toBe('p3')

    const user = await app.db.query('SELECT id, name FROM users WHERE email = $1', ['jane@example.com'])
    expect(user.rows).toHaveLength(1)
    expect(ticket.rows[0].requester_id).toBe(user.rows[0].id)

    const thread = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT body, meta FROM ticket_threads WHERE ticket_id = $1', [ticket.rows[0].id]),
    )
    expect(thread.rows[0].body).toContain('It happens every hour.')
    expect(thread.rows[0].meta.source).toBe('email')
  })

  it('does not duplicate the same message-id', async () => {
    const msgId = '<dup-1@example.com>'
    const email = rawEmail({ subject: 'Duplicate check', body: 'once', messageId: msgId })
    await processRawEmail(app.db, email, { tenantId })
    const second = await processRawEmail(app.db, email, { tenantId })
    expect(second.action).toBe('duplicate')
  })

  it('reuses an existing user for the requester', async () => {
    const before = await app.db.query('SELECT id FROM users WHERE email = $1', ['jane@example.com'])
    await processRawEmail(
      app.db,
      rawEmail({ from: 'Jane Doe <jane@example.com>', subject: 'Second issue', body: 'Still broken.' }),
      { tenantId },
    )
    const after = await app.db.query('SELECT id FROM users WHERE email = $1', ['jane@example.com'])
    expect(after.rows).toHaveLength(1)
    expect(after.rows[0].id).toBe(before.rows[0].id)
  })

  it('appends a reply to an existing ticket via subject number', async () => {
    const created = await processRawEmail(
      app.db,
      rawEmail({ subject: 'Keyboard backlight flickers', body: 'first report' }),
      { tenantId },
    )
    expect(created.ticketNumber).toBeDefined()

    const reply = await processRawEmail(
      app.db,
      rawEmail({
        subject: `Re: [#${created.ticketNumber}] Keyboard backlight flickers`,
        body: 'Actually it also hums now.',
      }),
      { tenantId },
    )
    expect(reply.action).toBe('replied')
    expect(reply.ticketNumber).toBe(created.ticketNumber)

    const ticket = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT * FROM tickets WHERE number = $1', [created.ticketNumber]),
    )
    const threads = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT body FROM ticket_threads WHERE ticket_id = $1 ORDER BY created_at', [ticket.rows[0].id]),
    )
    expect(threads.rows.map((r: { body: string }) => r.body)).toEqual([
      'first report',
      'Actually it also hums now.',
    ])
  })

  it('reopens a resolved ticket on email reply', async () => {
    const created = await processRawEmail(
      app.db,
      rawEmail({ subject: 'Headset static', body: 'intermittent' }),
      { tenantId },
    )
    const ticket = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT * FROM tickets WHERE number = $1', [created.ticketNumber]),
    )
    const ticketId = ticket.rows[0].id as string

    await withTenant(app.db, tenantId, (client) =>
      client.query(`UPDATE tickets SET status = 'resolved', resolved_at = now() WHERE id = $1`, [ticketId]),
    )

    const reopen = await processRawEmail(
      app.db,
      rawEmail({ subject: `Re: [#${created.ticketNumber}] Headset static`, body: 'still static' }),
      { tenantId },
    )
    expect(reopen.action).toBe('replied')

    const after = await withTenant(app.db, tenantId, (client) =>
      client.query('SELECT status, resolved_at FROM tickets WHERE id = $1', [ticketId]),
    )
    expect(after.rows[0].status).toBe('open')
    expect(after.rows[0].resolved_at).toBeNull()
  })
})
