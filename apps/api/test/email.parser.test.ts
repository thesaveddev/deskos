import { describe, expect, it } from 'vitest'
import { extractTicketNumber, parseRawEmail, stripHtml } from '../src/modules/email/email.parser.js'

describe('extractTicketNumber', () => {
  it('finds a bracketed number', () => {
    expect(extractTicketNumber('Re: [#1234] VPN is down')).toBe(1234)
  })

  it('finds a hashed number', () => {
    expect(extractTicketNumber('Printer jam #5678')).toBe(5678)
  })

  it('finds a bare number', () => {
    expect(extractTicketNumber('RE: FWD: 42 still broken')).toBe(42)
  })

  it('returns null when no number', () => {
    expect(extractTicketNumber('New issue with onboarding')).toBeNull()
    expect(extractTicketNumber('')).toBeNull()
  })

  it('does not treat arbitrary digits in text as a ticket number', () => {
    expect(extractTicketNumber('Re: invoice for $1,200')).toBeNull()
  })
})

describe('stripHtml', () => {
  it('removes tags and scripts', () => {
    const html = '<div><script>alert(1)</script><p>Hello <b>world</b></p></div>'
    expect(stripHtml(html)).toBe('Hello world')
  })

  it('decodes basic entities', () => {
    expect(stripHtml('<p>AT&amp;T &lt;3 &quot;quotes&quot;</p>')).toBe('AT&T <3 "quotes"')
  })
})

describe('parseRawEmail', () => {
  it('parses a plain-text email', async () => {
    const raw = [
      'From: Jane Doe <jane@example.com>',
      'To: support@reydesk.com',
      'Subject: Laptop charger not working',
      'Message-ID: <abc123@mail.example.com>',
      'Date: Tue, 12 Aug 2025 10:00:00 +0000',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'My charger died this morning.',
      '',
    ].join('\r\n')

    const email = await parseRawEmail(raw)
    expect(email.fromAddress).toBe('jane@example.com')
    expect(email.fromName).toBe('Jane Doe')
    expect(email.toAddress).toBe('support@reydesk.com')
    expect(email.subject).toBe('Laptop charger not working')
    expect(email.body).toContain('My charger died this morning.')
    expect(email.messageId).toBe('<abc123@mail.example.com>')
  })

  it('falls back to HTML body when no text part', async () => {
    const raw = [
      'From: a@example.com',
      'To: support@reydesk.com',
      'Subject: HTML only',
      'Content-Type: text/html',
      '',
      '<p>Please <b>fix</b> this.</p>',
      '',
    ].join('\r\n')
    const email = await parseRawEmail(raw)
    expect(email.body).toBe('Please fix this.')
  })
})
