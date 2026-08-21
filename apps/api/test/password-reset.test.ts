import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp, signupOwner, uniqueEmail } from './helpers.js'

describe('password reset email flow', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp({
      DESKOS_SMTP_HOST: 'smtp.test.local',
      DESKOS_SMTP_PORT: '587',
      DESKOS_SMTP_USER: 'notifications@example.test',
      DESKOS_SMTP_PASS: 'test-password',
      DESKOS_SMTP_FROM: 'ReyDesk <notifications@example.test>',
      DESKOS_SMTP_JSON: 'true',
    })
    owner = await signupOwner(app, { tenantName: 'Password Reset Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('queues and delivers a reset email with a usable one-time token', async () => {
    const before = app.mailer.sent.length
    const requested = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: owner.email.toUpperCase() },
    })
    expect(requested.statusCode).toBe(200)
    expect(app.mailer.sent.length).toBe(before + 1)

    const message = app.mailer.sent.at(-1)!
    expect(message.to).toBe(owner.email)
    expect(message.subject).toBe('Reset your ReyDesk password')
    expect(message.html).toBeTruthy()
    expect(message.html!).toContain('Reset your password')
    expect(message.html!).toContain('#e8a33d')
    const token = message.text.match(/token=([a-f0-9]{64})/)?.[1]
    expect(token).toMatch(/^[a-f0-9]{64}$/)

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'new-correct-horse-12345' },
    })
    expect(reset.statusCode).toBe(200)

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: owner.email, password: 'new-correct-horse-12345' },
    })
    expect(login.statusCode).toBe(200)

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'another-password-12345' },
    })
    expect(reuse.statusCode).toBe(400)
    expect(reuse.json().error.code).toBe('token_used')
  })

  it('reports outbound SMTP and queue readiness without exposing credentials', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/email/outbound/status', headers: { authorization: `Bearer ${owner.accessToken}` } })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ enabled: true, host: 'smtp.test.local', port: 587, fromConfigured: true })
    expect(status.json().queue).not.toHaveProperty('pass')
  })

  it('does not send an email or reveal whether an address exists', async () => {
    const before = app.mailer.sent.length
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: uniqueEmail('unknown') },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(app.mailer.sent.length).toBe(before)
  })
})
