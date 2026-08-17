import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import type { AiProvider } from '../src/modules/ai/gateway.js'

interface MockProvider extends AiProvider {
  calls: string[]
}

function makeMockProvider(): MockProvider {
  const calls: string[] = []
  return {
    calls,
    async generate(prompt) {
      calls.push(prompt)
      if (prompt.includes('Respond with ONLY a JSON object')) {
        return '{"title":"Reset a forgotten VPN password","body":"Symptom: VPN drops. Cause: expired password. Resolution: reset in Entra."}'
      }
      return 'User reports VPN disconnects; a password reset is recommended.'
    },
  }
}

describe('AI assistant', () => {
  let app: FastifyInstance
  let provider: MockProvider
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let analyst: Awaited<ReturnType<typeof seedActiveMember>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let vpnTicket: { id: string; number: number }
  let similarTicket: { id: string; number: number }
  let unrelatedTicket: { id: string; number: number }

  beforeAll(async () => {
    provider = makeMockProvider()
    app = await createTestApp({}, (instance) => {
      instance.decorate('aiProvider', provider)
    })
    owner = await signupOwner(app, { tenantName: 'AI Org' })
    analyst = await seedActiveMember(app, owner.tenantId!, 'analyst')
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'AI Foreign' })
    vpnTicket = await createTicket(owner, 'VPN keeps disconnecting during remote work', 'User cannot connect to the corporate VPN from home; password expired and keeps disconnecting.')
    similarTicket = await createTicket(owner, 'VPN password expired causing disconnects', 'VPN disconnects repeatedly because the password expired.')
    unrelatedTicket = await createTicket(owner, 'Printer is out of toner', 'The office printer shows a low toner warning.')
  })

  afterAll(async () => {
    await app.close()
  })

  async function createTicket(session: typeof owner, subject: string, description: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(session),
      payload: { subject, description },
    })
    expect(res.statusCode).toBe(201)
    return res.json().ticket as { id: string; number: number }
  }

  it('denies end users and allows analysts to use the assistant', async () => {
    const denied = await app.inject({ method: 'GET', url: `/api/v1/ai/tickets/${vpnTicket.id}/similar`, headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)

    const allowed = await app.inject({ method: 'GET', url: `/api/v1/ai/tickets/${vpnTicket.id}/similar`, headers: authHeaders(analyst) })
    expect(allowed.statusCode).toBe(200)
  })

  it('generates and stores an ai_summary thread entry', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/tickets/${vpnTicket.id}/summary`, headers: authHeaders(owner), payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json().summary).toContain('VPN')
    expect(res.json().id).toBeTruthy()
    expect(provider.calls.length).toBe(1)

    const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${vpnTicket.id}`, headers: authHeaders(owner) })
    const kinds = detail.json().threads.map((t: { kind: string }) => t.kind)
    expect(kinds).toContain('ai_summary')
  })

  it('ranks similar tickets by token overlap', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/ai/tickets/${vpnTicket.id}/similar`, headers: authHeaders(owner) })
    expect(res.statusCode).toBe(200)
    const similar = res.json().similar as Array<{ number: number; similarity: number }>
    expect(similar.length).toBeGreaterThan(0)
    expect(similar[0].number).toBe(similarTicket.number)
    expect(similar.every((s) => s.number !== unrelatedTicket.number)).toBe(true)
  })

  it('drafts a KB article as a human-reviewable draft', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/tickets/${vpnTicket.id}/kb-draft`, headers: authHeaders(owner), payload: {} })
    expect(res.statusCode).toBe(201)
    const article = res.json().article as { id: string; title: string; status: string; tags: string[] }
    expect(article.title).toBe('Reset a forgotten VPN password')
    expect(article.status).toBe('draft')
    expect(article.tags).toContain('ai-drafted')
  })

  it('isolates tickets between tenants', async () => {
    const similar = await app.inject({ method: 'GET', url: `/api/v1/ai/tickets/${vpnTicket.id}/similar`, headers: authHeaders(foreign) })
    expect(similar.statusCode).toBe(404)

    const summary = await app.inject({ method: 'POST', url: `/api/v1/ai/tickets/${vpnTicket.id}/summary`, headers: authHeaders(foreign), payload: {} })
    expect(summary.statusCode).toBe(404)
  })
})

describe('AI assistant disabled', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'AI Disabled Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('returns ai_disabled when the provider is not configured', async () => {
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'No AI here', description: 'desc' },
    })
    const id = ticket.json().ticket.id as string

    const res = await app.inject({ method: 'POST', url: `/api/v1/ai/tickets/${id}/summary`, headers: authHeaders(owner), payload: {} })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('ai_disabled')
  })
})
