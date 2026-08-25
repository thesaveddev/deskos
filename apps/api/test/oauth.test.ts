import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

async function clientCredentialsToken(app: FastifyInstance, id: string, secret: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/oauth/token',
    payload: { grant_type: 'client_credentials', client_id: id, client_secret: secret },
  })
  return response.json().access_token as string
}

describe('OAuth2 public API', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let securityAnalyst: Awaited<ReturnType<typeof seedActiveMember>>
  let clientId: string
  let clientSecret: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'OAuth Org' })
    foreign = await signupOwner(app, { tenantName: 'OAuth Foreign' })
    securityAnalyst = await seedActiveMember(app, owner.tenantId!, 'security_analyst')
    await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(owner), payload: { subject: 'OAuth visible', description: 'desc' } })
  })

  afterAll(async () => {
    await app.close()
  })

  it('registers a client (secret shown once) and enforces RBAC', async () => {
    const denied = await app.inject({ method: 'POST', url: '/api/v1/oauth/clients', headers: authHeaders(securityAnalyst), payload: { name: 'x' } })
    expect(denied.statusCode).toBe(403)

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/clients',
      headers: authHeaders(owner),
      payload: { name: 'CI integration', scopes: ['tickets:read'], grantTypes: ['client_credentials'] },
    })
    expect(res.statusCode).toBe(201)
    clientId = res.json().client.id
    clientSecret = res.json().clientSecret
    expect(clientSecret.startsWith('dsk_')).toBe(true)

    const list = await app.inject({ method: 'GET', url: '/api/v1/oauth/clients', headers: authHeaders(owner) })
    expect(list.json().clients).toHaveLength(1)
    expect(JSON.stringify(list.json())).not.toContain(clientSecret)
  })

  it('issues a client-credentials token and accesses the public API', async () => {
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret },
    })
    expect(tokenRes.statusCode).toBe(200)
    expect(tokenRes.json().token_type).toBe('Bearer')
    const accessToken = tokenRes.json().access_token as string

    const tickets = await app.inject({ method: 'GET', url: '/api/v1/public/tickets', headers: { authorization: `Bearer ${accessToken}` } })
    expect(tickets.statusCode).toBe(200)
    expect(tickets.json().tickets).toHaveLength(1)
    expect(tickets.json().tickets[0].subject).toBe('OAuth visible')
  })

  it('rejects bad client credentials', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: clientId, client_secret: 'wrong-secret' },
    })
    expect(bad.statusCode).toBe(401)
  })

  it('enforces scope on the protected resource', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/clients',
      headers: authHeaders(owner),
      payload: { name: 'Devices only', scopes: ['devices:read'], grantTypes: ['client_credentials'] },
    })
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: register.json().client.id, client_secret: register.json().clientSecret },
    })
    const denied = await app.inject({ method: 'GET', url: '/api/v1/public/tickets', headers: { authorization: `Bearer ${tokenRes.json().access_token}` } })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.denied_reason).toBe('insufficient_scope')
  })

  it('runs the authorization-code + PKCE flow and rejects replay', async () => {
    const verifier = 'v'.repeat(43)
    const challenge = createHash('sha256').update(verifier).digest('base64url')

    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/clients',
      headers: authHeaders(owner),
      payload: { name: 'SPA', scopes: ['tickets:read'], grantTypes: ['authorization_code'], redirectUris: ['https://app.example.com/cb'] },
    })
    const codeClientId = reg.json().client.id as string

    const authz = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/authorize',
      headers: authHeaders(owner),
      payload: { clientId: codeClientId, redirectUri: 'https://app.example.com/cb', codeChallenge: challenge, scopes: ['tickets:read'] },
    })
    expect(authz.statusCode).toBe(200)
    const code = authz.json().code as string

    const badVerifier = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'authorization_code', client_id: codeClientId, code, code_verifier: 'w'.repeat(43) },
    })
    expect(badVerifier.statusCode).toBe(400)
    expect(badVerifier.json().error.code).toBe('invalid_grant')

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'authorization_code', client_id: codeClientId, code, code_verifier: verifier },
    })
    expect(tokenRes.statusCode).toBe(200)
    const accessToken = tokenRes.json().access_token as string

    const tickets = await app.inject({ method: 'GET', url: '/api/v1/public/tickets', headers: { authorization: `Bearer ${accessToken}` } })
    expect(tickets.statusCode).toBe(200)

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'authorization_code', client_id: codeClientId, code, code_verifier: verifier },
    })
    expect(replay.statusCode).toBe(400)
    expect(replay.json().error.code).toBe('invalid_grant')
  })

  it('enforces the tenant IP allowlist for OAuth resources', async () => {
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/security/allowlist',
      headers: authHeaders(owner),
      payload: { cidr: '203.0.113.0/24', label: 'Documentation network' },
    })
    expect(blocked.statusCode).toBe(201)

    const enabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/oauth/security',
      headers: authHeaders(owner),
      payload: { enabled: true },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().ip_allowlist_enabled).toBe(true)

    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/public/tickets',
      headers: { authorization: `Bearer ${await clientCredentialsToken(app, clientId, clientSecret)}` },
    })
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.denied_reason).toBe('ip_not_allowlisted')

    const disabled = await app.inject({
      method: 'PATCH',
      url: '/api/v1/oauth/security',
      headers: authHeaders(owner),
      payload: { enabled: false },
    })
    expect(disabled.statusCode).toBe(200)
  })

  it('isolates tokens between tenants', async () => {
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/clients',
      headers: authHeaders(foreign),
      payload: { name: 'Foreign CI', scopes: ['tickets:read'], grantTypes: ['client_credentials'] },
    })
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/api/v1/oauth/token',
      payload: { grant_type: 'client_credentials', client_id: register.json().client.id, client_secret: register.json().clientSecret },
    })
    const tickets = await app.inject({ method: 'GET', url: '/api/v1/public/tickets', headers: { authorization: `Bearer ${tokenRes.json().access_token}` } })
    expect(tickets.statusCode).toBe(200)
    expect(tickets.json().tickets).toEqual([])
  })
})
