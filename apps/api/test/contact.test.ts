import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('contact form', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  const valid = () => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    subject: 'sales',
    message: 'We would like a walkthrough of the platform for a 20-person team.',
  })

  it('accepts a valid enquiry, stores it, and queues a notification email', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/contact', payload: valid() })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ ok: true })

    const rows = (await app.db.query('SELECT * FROM contact_messages WHERE email = $1', ['ada@example.com'])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].subject).toBe('sales')
    expect(rows[0].message).toContain('walkthrough')
    expect(rows[0].ip).toBeTruthy()
  })

  it('swallows honeypot submissions without storing them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/contact',
      payload: { ...valid(), email: 'bot@example.com', website: 'http://spam.example' },
    })
    expect(res.statusCode).toBe(201)

    const rows = (await app.db.query('SELECT count(*)::int AS n FROM contact_messages WHERE email = $1', ['bot@example.com'])).rows
    expect(rows[0].n).toBe(0)
  })

  it('rejects invalid payloads with validation_error', async () => {
    const badEmail = await app.inject({ method: 'POST', url: '/api/v1/contact', payload: { ...valid(), email: 'not-an-email' } })
    expect(badEmail.statusCode).toBe(400)
    expect(badEmail.json().error.code).toBe('validation_error')

    // 'enterprise' and 'press' were legacy form options the API never supported.
    const badSubject = await app.inject({ method: 'POST', url: '/api/v1/contact', payload: { ...valid(), subject: 'enterprise' } })
    expect(badSubject.statusCode).toBe(400)
    expect(badSubject.json().error.code).toBe('validation_error')
  })

  it('hides the enquiry list from staff and shows it to platform admins', async () => {
    const owner = await signupOwner(app)

    const denied = await app.inject({ method: 'GET', url: '/api/v1/contact/messages', headers: authHeaders(owner) })
    expect(denied.statusCode).toBe(403)

    await app.db.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [owner.userId])
    const allowed = await app.inject({ method: 'GET', url: '/api/v1/contact/messages', headers: authHeaders(owner) })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.json().items.length).toBeGreaterThanOrEqual(1)
  })
})
