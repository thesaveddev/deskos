import { describe, expect, it } from 'vitest'
import { buildTwilioSignatureInput, dispatchTwilioCall, mapTwilioStatus, parseTwilioWebhook, verifyTwilioSignature } from '../src/modules/telephony/twilio.js'
import { createHmac } from 'node:crypto'

describe('Twilio telephony adapter', () => {
  it('maps provider statuses to ReyDesk call states', () => {
    expect(mapTwilioStatus('queued')).toBe('ringing')
    expect(mapTwilioStatus('in-progress')).toBe('answered')
    expect(mapTwilioStatus('completed')).toBe('completed')
    expect(mapTwilioStatus('no-answer')).toBe('missed')
    expect(mapTwilioStatus('failed')).toBe('failed')
  })

  it('builds and dispatches a form-encoded Twilio call request', async () => {
    let captured: { url: string; headers: Record<string, string>; body: URLSearchParams } | null = null
    const result = await dispatchTwilioCall({
      toNumber: '+15551234567',
      callId: 'desk-call-1',
      authToken: 'twilio-auth-token',
      config: { accountSid: 'AC123', fromNumber: '+15557654321', twimlUrl: 'https://example.com/twiml', webhookUrl: 'https://api.example.com/twilio' },
    }, async (url, init) => {
      captured = { url, headers: init.headers, body: new URLSearchParams(init.body) }
      return { ok: true, status: 201, json: async () => ({ sid: 'CA123', status: 'queued' }), text: async () => '' }
    })
    expect(result.providerCallId).toBe('CA123')
    expect(result.status).toBe('ringing')
    expect(captured?.url).toContain('/Accounts/AC123/Calls.json')
    expect(captured?.headers.authorization).toMatch(/^Basic /)
    expect(captured?.body.get('To')).toBe('+15551234567')
    expect(captured?.body.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed'])
    expect(captured?.body.get('StatusCallback')).toBe('https://api.example.com/twilio')
  })

  it('verifies Twilio signatures and parses status callbacks', () => {
    const url = 'https://api.example.com/api/v1/telephony/webhooks/123'
    const params = { CallSid: 'CA123', CallStatus: 'completed', Direction: 'inbound', From: '+15551234567', To: '+15557654321', CallDuration: '42' }
    const signature = createHmac('sha1', 'secret').update(buildTwilioSignatureInput(url, params)).digest('base64')
    expect(verifyTwilioSignature('secret', url, params, signature)).toBe(true)
    expect(verifyTwilioSignature('secret', url, params, 'not-valid')).toBe(false)
    const parsed = parseTwilioWebhook(params)
    expect(parsed.providerCallId).toBe('CA123')
    expect(parsed.direction).toBe('inbound')
    expect(parsed.status).toBe('completed')
    expect(parsed.durationSec).toBe(42)
  })
})
