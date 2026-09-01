import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'

describe('webhook integrations (Teams/Slack)', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let securityAnalyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let endpointId: string
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = []

  beforeAll(async () => {
    app = await createTestApp({}, (a) => {
      a.decorate('webhookHttp', async (url: string, headers: Record<string, string>, body: string) => {
        calls.push({ url, headers, body })
        return 200
      })
    })
    owner = await signupOwner(app, { tenantName: 'Webhooks Org' })
    securityAnalyst = await seedActiveMember(app, owner.tenantId!, 'security_analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
  })

  afterAll(async () => {
    await app.close()
  })

  it('enforces RBAC on read and manage', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const analystDenied = await app.inject({ method: 'POST', url: '/api/v1/webhooks', headers: authHeaders(securityAnalyst), payload: { name: 'x', url: 'https://e.com/hook' } })
    expect(analystDenied.statusCode).toBe(403)

    const read = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: authHeaders(securityAnalyst) })
    expect(read.statusCode).toBe(200)
    expect(read.json().endpoints).toEqual([])
  })

  it('creates an endpoint and never exposes the secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: authHeaders(owner),
      payload: { name: 'Slack #it-alerts', url: 'https://hooks.slack.com/services/T/B/X', secret: 's3cret-value', channel: 'slack', events: ['ticket.*', 'session.*'] },
    })
    expect(res.statusCode).toBe(201)
    endpointId = res.json().endpoint.id
    expect(res.json().endpoint.hasSecret).toBe(true)
    expect(JSON.stringify(res.json())).not.toContain('s3cret-value')

    const list = await app.inject({ method: 'GET', url: '/api/v1/webhooks', headers: authHeaders(owner) })
    expect(list.json().endpoints).toHaveLength(1)
    expect(list.json().endpoints[0].channel).toBe('slack')
    expect(list.json().endpoints[0].events).toContain('ticket.*')
  })

  it('sends a signed, channel-formatted test delivery and logs it', async () => {
    const test = await app.inject({ method: 'POST', url: `/api/v1/webhooks/${endpointId}/test`, headers: authHeaders(owner) })
    expect(test.statusCode).toBe(200)
    expect(test.json().status).toBe('sent')

    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call.url).toBe('https://hooks.slack.com/services/T/B/X')
    expect(call.headers['x-reydesk-event']).toBe('webhook.test')
    expect(call.headers['x-reydesk-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    const body = JSON.parse(call.body)
    expect(body.text).toContain('webhook.test')

    const deliveries = await app.inject({ method: 'GET', url: `/api/v1/webhooks/${endpointId}/deliveries`, headers: authHeaders(owner) })
    expect(deliveries.statusCode).toBe(200)
    expect(deliveries.json().deliveries).toHaveLength(1)
    expect(deliveries.json().deliveries[0].event).toBe('webhook.test')
    expect(deliveries.json().deliveries[0].status).toBe('sent')
  })

  it('fans out ticket.created events to subscribed endpoints', async () => {
    const before = calls.length
    await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(owner), payload: { subject: 'Webhook fan-out', description: 'desc' } })
    // Fire-and-forget delivery: give the in-process promise a moment to resolve.
    await new Promise((r) => setTimeout(r, 400))

    expect(calls.length).toBeGreaterThan(before)
    const latest = calls[calls.length - 1]
    expect(latest.headers['x-reydesk-event']).toBe('ticket.created')
    expect(JSON.parse(latest.body).text).toContain('ticket.created')

    const deliveries = await app.inject({ method: 'GET', url: `/api/v1/webhooks/${endpointId}/deliveries`, headers: authHeaders(owner) })
    const events = (deliveries.json().deliveries as Array<{ event: string }>).map((d) => d.event)
    expect(events).toContain('ticket.created')
  })

  it('does not deliver to endpoints not subscribed to the event', async () => {
    const before = calls.length
    await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks',
      headers: authHeaders(owner),
      payload: { name: 'Device-only', url: 'https://hooks.slack.com/services/T/B/D', channel: 'slack', events: ['device.*'] },
    })
    await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(owner), payload: { subject: 'Another', description: 'desc' } })
    await new Promise((r) => setTimeout(r, 400))
    // Only the ticket.* endpoint fired, not the device.* one.
    const newCalls = calls.slice(before)
    expect(newCalls.every((c) => c.url === 'https://hooks.slack.com/services/T/B/X')).toBe(true)
  })
})
