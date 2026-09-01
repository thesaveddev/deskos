import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, seedActiveMember, signupOwner } from './helpers.js'
import type { AiProvider } from '../src/modules/ai/gateway.js'
import { parseWorkerPlan } from '../src/modules/ai-worker/engine.js'

interface MockProvider extends AiProvider {
  calls: string[]
}

function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for AI worker'))
      setTimeout(() => void poll(), 25)
    }
    void poll()
  })
}

describe('AI workers', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let endUser: Awaited<ReturnType<typeof seedActiveMember>>
  let foreign: Awaited<ReturnType<typeof signupOwner>>
  let provider: MockProvider

  beforeAll(async () => {
    provider = {
      calls: [],
      async generate(prompt) {
        this.calls.push(prompt)
        // The finalize call asks for a bare {action,message} decision.
        if (prompt.includes('Decide the final outcome')) {
          return JSON.stringify({ action: 'resolve', message: 'This issue is resolved.' })
        }
        const ticketId = prompt.match(/Ticket id: ([0-9a-f-]{36})/)?.[1]
        if (!ticketId) return JSON.stringify({ summary: 'no ticket id', steps: [], final: { action: 'handoff', message: 'missing' } })
        return JSON.stringify({
          summary: 'Read the ticket and close it as a known no-device fix.',
          steps: [{ tool: 'ticket.get', args: { ticketId }, rationale: 'Understand the issue.' }],
          final: { action: 'resolve', message: 'This issue is resolved.' },
        })
      },
    }
    app = await createTestApp({ REYDESK_SMTP_JSON: 'true', REYDESK_SMTP_FROM: 'ReyDesk <support@example.com>' }, (instance) => {
      instance.decorate('aiProvider', provider)
    })
    owner = await signupOwner(app, { tenantName: 'AI Worker Org' })
    endUser = await seedActiveMember(app, owner.tenantId!, 'end_user')
    foreign = await signupOwner(app, { tenantName: 'AI Worker Foreign' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('parses a valid plan and rejects malformed output', () => {
    const plan = parseWorkerPlan('{"summary":"fix","steps":[{"tool":"ticket.get","args":{"ticketId":"11111111-1111-1111-1111-111111111111"},"rationale":"read"}],"final":{"action":"resolve","message":"done"}}')
    expect(plan).not.toBeNull()
    expect(plan!.steps[0].tool).toBe('ticket.get')
    expect(plan!.final.action).toBe('resolve')
    expect(parseWorkerPlan('not json')).toBeNull()
    expect(parseWorkerPlan('{"steps":[],"final":{"action":"resolve","message":"x"}}')).toBeNull()
  })

  it('enforces RBAC on worker run endpoints', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/ai-worker/runs', headers: authHeaders(endUser) })
    expect(denied.statusCode).toBe(403)
    const read = await app.inject({ method: 'GET', url: '/api/v1/ai-worker/runs', headers: authHeaders(owner) })
    expect(read.statusCode).toBe(200)
    expect(read.json().runs).toEqual([])
  })

  it('runs a worker that reads the ticket and resolves it', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Printer jam', description: 'The printer is jammed and needs attention.' },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().ticket.id as string

    const started = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-worker/runs',
      headers: authHeaders(owner),
      payload: { ticketId },
    })
    expect(started.statusCode).toBe(201)
    const runId = started.json().run.id as string

    await waitFor(async () => {
      const detail = await app.inject({ method: 'GET', url: `/api/v1/ai-worker/runs/${runId}`, headers: authHeaders(owner) })
      return detail.json().run.status === 'resolved'
    })
    const detail = await app.inject({ method: 'GET', url: `/api/v1/ai-worker/runs/${runId}`, headers: authHeaders(owner) })
    const run = detail.json().run
    expect(run.status).toBe('resolved')
    expect(run.steps.length).toBeGreaterThan(0)
    expect(run.steps[0].tool).toBe('ticket.get')
    expect(run.steps[0].status).toBe('succeeded')

    // The ticket is resolved and the requester got a public thread entry.
    const ticketDetail = await app.inject({ method: 'GET', url: `/api/v1/portal/tickets/${created.json().ticket.number}`, headers: authHeaders(owner) })
    expect(ticketDetail.json().ticket.status).toBe('resolved')
    expect(ticketDetail.json().threads.some((thread: { kind: string; body: string }) => thread.kind === 'ai_worker' && thread.body.includes('resolved'))).toBe(true)
  })

  it('rejects starting a worker on a resolved ticket, dedupes active runs, and isolates tenants', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Another issue', description: 'Something else broke.' },
    })
    const ticketId = created.json().ticket.id as string

    // Resolve the ticket directly so the assertion is deterministic.
    const resolved = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${created.json().ticket.number}/resolve`,
      headers: authHeaders(owner),
    })
    expect([200, 204].includes(resolved.statusCode)).toBe(true)

    // A worker cannot start on a resolved ticket.
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-worker/runs',
      headers: authHeaders(owner),
      payload: { ticketId },
    })
    expect(again.statusCode).toBe(400)

    // A second worker on the same open ticket is rejected while one is active.
    const open = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Third issue', description: 'Open for dedupe check.' },
    })
    const openTicketId = open.json().ticket.id as string
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-worker/runs',
      headers: authHeaders(owner),
      payload: { ticketId: openTicketId },
    })
    expect(first.statusCode).toBe(201)
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/ai-worker/runs',
      headers: authHeaders(owner),
      payload: { ticketId: openTicketId },
    })
    // Either the first run is still active (409) or it already resolved the
    // ticket (400) — both prove a second worker is rejected either way.
    expect([400, 409].includes(second.statusCode)).toBe(true)

    // The foreign tenant sees none of these runs.
    const foreignList = await app.inject({ method: 'GET', url: '/api/v1/ai-worker/runs', headers: authHeaders(foreign) })
    expect(foreignList.statusCode).toBe(200)
    expect(foreignList.json().runs).toEqual([])
  })
})