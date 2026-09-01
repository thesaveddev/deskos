import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'
import { withTenant } from '../src/db/pool.js'
import { buildTwilioSignatureInput } from '../src/modules/telephony/twilio.js'

describe('telephony CTI workflows', () => {
  let app: FastifyInstance
  let owner: Awaited<ReturnType<typeof signupOwner>>
  let integrationId: string
  let webhookToken: string
  let ticketId: string

  beforeAll(async () => {
    app = await createTestApp()
    owner = await signupOwner(app, { tenantName: 'CTI Org' })
    const ticket = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: authHeaders(owner), payload: { subject: 'Caller connectivity issue', description: 'Phone report' } })
    expect(ticket.statusCode).toBe(201)
    ticketId = ticket.json().ticket.id
    await withTenant(app.db, owner.tenantId!, async (client) => {
      await client.query('INSERT INTO contacts (tenant_id, name, email, phone) VALUES ($1, $2, $3, $4)', [owner.tenantId, 'Test Owner', owner.email, '+44 20 7946 0123'])
    })
    const created = await app.inject({ method: 'POST', url: '/api/v1/telephony/integrations', headers: authHeaders(owner), payload: { name: 'Main PBX', provider: 'generic', autoMatch: true } })
    expect(created.statusCode).toBe(201)
    integrationId = created.json().integration.id
    webhookToken = created.json().webhookToken
  })

  afterAll(async () => { await app.close() })

  it('creates a secure inbound integration and matches one open ticket', async () => {
    const inbound = await app.inject({
      method: 'POST', url: `/api/v1/telephony/webhooks/${integrationId}`,
      headers: { 'x-reydesk-telephony-token': webhookToken },
      payload: { event: 'call.answered', callId: 'provider-call-1', from: '+442079460123', to: '+44200000000', status: 'answered', duration: 12 },
    })
    expect(inbound.statusCode).toBe(200)
    expect(inbound.json().match.status).toBe('matched')
    expect(inbound.json().call.ticketId).toBe(ticketId)

    const timeline = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT body, meta FROM ticket_threads WHERE ticket_id = $1 AND meta @> '{"event":"telephony.call.received"}'`, [ticketId]).then((result) => result.rows[0]))
    expect(timeline.body).toContain('inbound call')
    expect(timeline.meta.matchStatus).toBe('matched')
  })

  it('updates the same provider call id idempotently and records status activity', async () => {
    const update = await app.inject({ method: 'POST', url: `/api/v1/telephony/webhooks/${integrationId}`, headers: { 'x-reydesk-telephony-token': webhookToken }, payload: { event: 'call.completed', callId: 'provider-call-1', from: '+442079460123', status: 'completed', duration: 44 } })
    expect(update.statusCode).toBe(200)
    const calls = await app.inject({ method: 'GET', url: '/api/v1/telephony/calls', headers: authHeaders(owner) })
    expect(calls.json().calls).toHaveLength(1)
    expect(calls.json().calls[0].status).toBe('completed')
    const events = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT meta FROM ticket_threads WHERE ticket_id = $1 AND meta @> '{"event":"telephony.call.updated"}'`, [ticketId]).then((result) => result.rows))
    expect(events.length).toBeGreaterThan(0)
  })

  it('supports click-to-call and writes an activity to the linked ticket', async () => {
    const started = await app.inject({ method: 'POST', url: '/api/v1/telephony/click-to-call', headers: authHeaders(owner), payload: { toNumber: '+442079460123', ticketId } })
    expect(started.statusCode).toBe(201)
    expect(started.json().dialUri).toBe('tel:+442079460123')
    expect(started.json().call.status).toBe('ringing')
    const events = await withTenant(app.db, owner.tenantId!, (client) => client.query(`SELECT body FROM ticket_threads WHERE ticket_id = $1 AND meta @> '{"event":"telephony.click_to_call"}'`, [ticketId]).then((result) => result.rows))
    expect(events.length).toBeGreaterThan(0)
  })

  it('supports Twilio signed callbacks and maps provider status', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/telephony/integrations', headers: authHeaders(owner), payload: { name: 'Twilio Support', provider: 'twilio', providerSecret: 'twilio-auth-token', providerConfig: { accountSid: 'AC123', fromNumber: '+15557654321', twimlUrl: 'https://example.com/twiml' }, autoMatch: false } })
    expect(created.statusCode).toBe(201)
    const twilioIntegrationId = created.json().integration.id as string
    const payload = { CallSid: 'CA-twilio-1', CallStatus: 'in-progress', Direction: 'inbound', From: '+15551234567', To: '+15557654321', CallDuration: '0' }
    const callbackUrl = `http://localhost:80/api/v1/telephony/webhooks/${twilioIntegrationId}`
    const signature = createHmac('sha1', 'twilio-auth-token').update(buildTwilioSignatureInput(callbackUrl, payload)).digest('base64')
    const inbound = await app.inject({ method: 'POST', url: `/api/v1/telephony/webhooks/${twilioIntegrationId}`, headers: { 'x-twilio-signature': signature }, payload })
    expect(inbound.statusCode).toBe(200)
    expect(inbound.json().call.status).toBe('answered')

    const invalid = await app.inject({ method: 'POST', url: `/api/v1/telephony/webhooks/${twilioIntegrationId}`, headers: { 'x-twilio-signature': 'bad' }, payload: { ...payload, CallStatus: 'completed' } })
    expect(invalid.statusCode).toBe(401)
  })

  it('rejects invalid webhook tokens and does not expose the stored token', async () => {
    const invalid = await app.inject({ method: 'POST', url: `/api/v1/telephony/webhooks/${integrationId}`, headers: { 'x-reydesk-telephony-token': 'reydesk_cti_invalid_token_value' }, payload: { callId: 'bad' } })
    expect(invalid.statusCode).toBe(401)
    const list = await app.inject({ method: 'GET', url: '/api/v1/telephony/integrations', headers: authHeaders(owner) })
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.json())).not.toContain(webhookToken)
    expect(list.json().integrations.find((item: { id: string }) => item.id === integrationId).webhook_path).toContain(integrationId)
  })
})
