import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { totpAt } from '../src/core/auth/totp.js'
import { createTestApp, signupOwner, uniqueEmail } from './helpers.js'

describe('auth', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('signs up a new tenant owner and returns tokens', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: {
        email: uniqueEmail('signup'),
        password: 'a-strong-passphrase-1',
        name: 'New Owner',
        tenantName: 'Signup Org',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.accessToken).toBeTruthy()
    expect(body.refreshToken).toBeTruthy()
    expect(body.tenant.slug).toBeTruthy()
    expect(body.user.email).toBeTruthy()
  })

  it('rejects duplicate signup email with 409', async () => {
    const email = uniqueEmail('dup')
    const payload = { email, password: 'a-strong-passphrase-1', name: 'X', tenantName: 'Dup Org' }
    const first = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({ method: 'POST', url: '/api/v1/auth/signup', payload })
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('email_taken')
  })

  it('logs in with valid credentials', async () => {
    const email = uniqueEmail('login')
    const password = 'a-strong-passphrase-1'
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password, name: 'L', tenantName: 'Login Org' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().accessToken).toBeTruthy()
  })

  it('returns human-friendly validation guidance for empty login fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: '', password: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toEqual({
      code: 'validation_error',
      message: 'Enter a valid email address and your password.',
    })
  })

  it('rejects invalid password with 401', async () => {
    const email = uniqueEmail('badpw')
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/signup',
      payload: { email, password: 'a-strong-passphrase-1', name: 'B', tenantName: 'BadPw Org' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'wrong-password-12345' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('invalid_credentials')
  })

  it('rotates refresh tokens and detects reuse', async () => {
    const session = await signupOwner(app)
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })
    expect(first.statusCode).toBe(200)
    const rotated = first.json().refreshToken
    expect(rotated).not.toBe(session.refreshToken)

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })
    expect(reuse.statusCode).toBe(401)
    expect(reuse.json().error.code).toBe('refresh_reuse')
  })

  it('enforces MFA when enabled', async () => {
    const session = await signupOwner(app)
    const auth = { authorization: `Bearer ${session.accessToken}` }

    const enable = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/enable', headers: auth })
    expect(enable.statusCode).toBe(200)
    const secret = enable.json().secret as string

    const code = totpAt(secret, Date.now())
    const verify = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/verify', headers: auth, payload: { code } })
    expect(verify.statusCode).toBe(200)
    expect(verify.json().mfaEnabled).toBe(true)

    const email = session.email
    const noCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'correct-horse-battery-9' },
    })
    expect(noCode.statusCode).toBe(401)
    expect(noCode.json().error.code).toBe('mfa_required')

    const withCode = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'correct-horse-battery-9', mfaCode: totpAt(secret, Date.now()) },
    })
    expect(withCode.statusCode).toBe(200)
  })

  it('guides a required-MFA user through setup and supports one-time recovery codes', async () => {
    const session = await signupOwner(app, { tenantName: 'Required MFA Org' })
    await app.db.query('UPDATE tenants SET settings = $2::jsonb WHERE id = $1', [session.tenantId, JSON.stringify({ mfa_policy: 'required' })])

    const blocked = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: session.email, password: 'correct-horse-battery-9' } })
    expect(blocked.statusCode).toBe(403)
    expect(blocked.json().error.code).toBe('mfa_setup_required')
    const setupToken = blocked.json().error.details.setup_token as string
    expect(setupToken).toMatch(/^mfa_setup_/)

    const begin = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup/begin', payload: { setupToken } })
    expect(begin.statusCode).toBe(200)
    const secret = begin.json().secret as string
    const complete = await app.inject({ method: 'POST', url: '/api/v1/auth/mfa/setup/complete', payload: { setupToken, code: totpAt(secret, Date.now()) } })
    expect(complete.statusCode).toBe(200)
    const recoveryCode = complete.json().recoveryCodes[0] as string
    expect(complete.json().recoveryCodes).toHaveLength(10)

    const meAfterSetup = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${complete.json().accessToken}` },
    })
    expect(meAfterSetup.statusCode).toBe(200)
    expect(meAfterSetup.json().user.email).toBe(session.email)

    const recoveryLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: session.email, password: 'correct-horse-battery-9', mfaCode: recoveryCode } })
    expect(recoveryLogin.statusCode).toBe(200)
    const reused = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: session.email, password: 'correct-horse-battery-9', mfaCode: recoveryCode } })
    expect(reused.statusCode).toBe(401)
    expect(reused.json().error.code).toBe('mfa_invalid')
  })

  it('rejects /me without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' })
    expect(res.statusCode).toBe(401)
  })
})
