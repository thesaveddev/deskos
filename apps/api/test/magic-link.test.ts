import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { totpAt } from '../src/core/auth/totp.js'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

function tokenFromLastEmail(app: FastifyInstance): string {
  const mail = app.mailer.sent.at(-1)
  if (!mail) throw new Error('Expected a magic-link email')
  const match = mail.text.match(/magic_token=([^\s]+)/)
  if (!match?.[1]) throw new Error(`No magic token in email: ${mail.text}`)
  return decodeURIComponent(match[1])
}

describe('magic-link authentication', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp({
      DESKOS_SMTP_JSON: 'true',
      DESKOS_SMTP_FROM: 'DeskOS <no-reply@example.com>',
    })
  })

  afterAll(async () => {
    await app.close()
  })

  it('enables portal users by default and consumes a link once', async () => {
    const owner = await signupOwner(app, { tenantName: 'Magic Portal Org' })
    const requester = await seedActiveMember(app, owner.tenantId!, 'end_user')
    const before = app.mailer.sent.length

    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      payload: { email: requester.email },
    })
    expect(request.statusCode).toBe(200)
    expect(request.json()).toEqual({ ok: true })
    expect(app.mailer.sent.length).toBe(before + 1)
    expect(app.mailer.sent.at(-1)?.html).toContain('Sign in to DeskOS')
    expect(app.mailer.sent.at(-1)?.html).toContain('#e8a33d')

    const token = tokenFromLastEmail(app)
    const verified = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json().tenant.id).toBe(owner.tenantId)
    expect(verified.json().accessToken).toBeTruthy()

    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token },
    })
    expect(reused.statusCode).toBe(401)
    expect(reused.json().error.code).toBe('magic_link_expired')
  })

  it('does not enable staff magic links until the organization opts in', async () => {
    const owner = await signupOwner(app, { tenantName: 'Staff Magic Org' })
    const before = app.mailer.sent.length
    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      payload: { email: owner.email },
    })
    expect(request.statusCode).toBe(200)
    expect(app.mailer.sent.length).toBe(before)

    await app.db.query(
      `UPDATE tenants SET settings = $2::jsonb WHERE id = $1`,
      [owner.tenantId, JSON.stringify({ magic_links: { portal_enabled: true, staff_enabled: true } })],
    )
    const optedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/request',
      payload: { email: owner.email },
    })
    expect(optedIn.statusCode).toBe(200)
    expect(app.mailer.sent.length).toBe(before + 1)
  })

  it('requires MFA after a portal magic link when MFA is enabled', async () => {
    const owner = await signupOwner(app, { tenantName: 'MFA Magic Org' })
    const requester = await seedActiveMember(app, owner.tenantId!, 'end_user')
    const auth = authHeaders(requester)
    const enable = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enable', headers: auth })
    const secret = enable.json().secret as string
    const code = totpAt(secret, Date.now())
    const enrolled = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', headers: auth, payload: { code } })
    expect(enrolled.statusCode).toBe(200)

    await app.inject({ method: 'POST', url: '/api/v1/auth/magic-link/request', payload: { email: requester.email } })
    const token = tokenFromLastEmail(app)
    const pending = await app.inject({ method: 'POST', url: '/api/v1/auth/magic-link/verify', payload: { token } })
    expect(pending.statusCode).toBe(401)
    expect(pending.json().error.code).toBe('magic_mfa_required')

    const completed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/magic-link/verify',
      payload: { token, mfaCode: totpAt(secret, Date.now()) },
    })
    expect(completed.statusCode).toBe(200)
    expect(completed.json().accessToken).toBeTruthy()
  })
})
