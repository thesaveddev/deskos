import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'
import type { AiProvider } from '../src/modules/ai/gateway.js'
import { normalizeTriagePolicy, parseTriageDecision } from '../src/modules/ai/triage.js'

interface MockProvider extends AiProvider {
  calls: string[]
  mode: 'ask' | 'resolve' | 'handoff'
}

function waitFor(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await check()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('Timed out waiting for AI triage'))
      setTimeout(() => void poll(), 25)
    }
    void poll()
  })
}

describe('AI ticket triage', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let provider: MockProvider

  beforeAll(async () => {
    provider = {
      calls: [],
      mode: 'ask',
      async generate(prompt) {
        this.calls.push(prompt)
        if (this.mode === 'ask') return JSON.stringify({ action: 'ask_user', message: 'Is the mouse wired or wireless, and does its light turn on?', question: 'Is the mouse wired or wireless?', confidence: 0.82 })
        if (this.mode === 'resolve') return JSON.stringify({ action: 'resolve', message: 'Great — I am glad the mouse is working again. I am closing this request.', confidence: 0.98 })
        return JSON.stringify({ action: 'handoff', message: 'This needs a technician to investigate safely. A member of the support team will take over.', confidence: 0.7 })
      },
    }
    app = await createTestApp({ DESKOS_SMTP_JSON: 'true', DESKOS_SMTP_FROM: 'DeskOS <support@example.com>' }, (instance) => {
      instance.decorate('aiProvider', provider)
    })
    owner = await signupOwner(app, { tenantName: 'AI Triage Org' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('normalizes safe defaults and rejects malformed model output', () => {
    expect(normalizeTriagePolicy({ maxRounds: 99, resolveConfidence: 0.1 }).maxRounds).toBe(8)
    expect(normalizeTriagePolicy({ maxRounds: 99, resolveConfidence: 0.1 }).resolveConfidence).toBe(0.5)
    expect(parseTriageDecision('not json')).toBeNull()
    expect(parseTriageDecision('{"action":"run_command","message":"bad"}')).toBeNull()
    expect(parseTriageDecision('{"action":"handoff","message":"A technician should review this.","confidence":0.76,"rationale":"The request may require privileged access.","evidence":["Requester reported repeated failures"],"policyExplanation":"Do not automate privileged changes."}')).toMatchObject({
      action: 'handoff',
      confidence: 0.76,
      rationale: 'The request may require privileged access.',
      evidence: ['Requester reported repeated failures'],
      policyExplanation: 'Do not automate privileged changes.',
    })
  })

  it('asks a requester a diagnostic question, then resolves after confirmation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'My mouse is not working', description: 'The pointer does not move.' },
    })
    expect(created.statusCode).toBe(201)
    const number = created.json().ticket.number as number

    await waitFor(async () => {
      const detail = await app.inject({ method: 'GET', url: `/api/v1/portal/tickets/${number}`, headers: authHeaders(owner) })
      return detail.json().threads.some((thread: { kind: string }) => thread.kind === 'ai_triage')
    })
    expect(provider.calls[0]).toContain('untrusted data')

    const triage = await app.inject({ method: 'GET', url: `/api/v1/ai/tickets/${created.json().ticket.id}/triage`, headers: authHeaders(owner) })
    expect(triage.statusCode).toBe(200)
    expect(triage.json().triage.transcript[0]).toMatchObject({ action: 'ask_user', confidence: 0.82, evidence: [] })

    provider.mode = 'resolve'
    const reply = await app.inject({
      method: 'POST',
      url: `/api/v1/portal/tickets/${number}/reply`,
      headers: authHeaders(owner),
      payload: { body: 'It is wireless, the battery was flat, and it works after replacing it.' },
    })
    expect(reply.statusCode).toBe(201)

    await waitFor(async () => {
      const detail = await app.inject({ method: 'GET', url: `/api/v1/portal/tickets/${number}`, headers: authHeaders(owner) })
      return detail.json().ticket.status === 'resolved'
    })
    const mail = app.mailer.sent.find((message) => message.subject.startsWith('Resolved:') && message.subject.includes(`[${number}]`))
    expect(mail).toBeTruthy()
    expect(mail!.text).toContain('mouse is working again')
  })

  it('hands off when the provider returns an unsafe or uncertain path', async () => {
    provider.mode = 'handoff'
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/portal/tickets',
      headers: authHeaders(owner),
      payload: { subject: 'Suspicious account activity', description: 'I think someone accessed my account.' },
    })
    const number = created.json().ticket.number as number
    await waitFor(async () => {
      const triage = await app.inject({ method: 'GET', url: `/api/v1/tickets?q=${number}`, headers: authHeaders(owner) })
      return triage.json().tickets[0]?.ext?.aiTriage?.status === 'handoff'
    })
    const detail = await app.inject({ method: 'GET', url: `/api/v1/portal/tickets/${number}`, headers: authHeaders(owner) })
    expect(detail.json().threads.at(-1).body).toContain('technician')
  })
})
