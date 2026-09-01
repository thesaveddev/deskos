import { createHmac, timingSafeEqual } from 'node:crypto'

export type TwilioCallStatus = 'queued' | 'initiated' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'canceled' | 'failed'
export type DeskCallStatus = 'ringing' | 'answered' | 'missed' | 'completed' | 'failed'

export interface TwilioConfig {
  accountSid: string
  fromNumber: string
  twimlUrl: string
  webhookUrl?: string
}

export interface TwilioCallRequest {
  toNumber: string
  callId: string
  config: TwilioConfig
  authToken: string
}

export interface TwilioFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export type TwilioFetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<TwilioFetchResponse>

export function mapTwilioStatus(value: string | null | undefined): DeskCallStatus {
  switch ((value ?? '').toLowerCase()) {
    case 'completed': return 'completed'
    case 'in-progress': return 'answered'
    case 'busy':
    case 'no-answer': return 'missed'
    case 'failed':
    case 'canceled': return 'failed'
    default: return 'ringing'
  }
}

function encodeForm(values: Record<string, string>): string {
  const form = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (key === 'StatusCallbackEvent') {
      for (const event of value.split(' ')) form.append(key, event)
    } else {
      form.set(key, value)
    }
  }
  return form.toString()
}

function basicAuth(accountSid: string, authToken: string): string {
  return Buffer.from(`${accountSid}:${authToken}`).toString('base64')
}

export async function dispatchTwilioCall(input: TwilioCallRequest, fetcher: TwilioFetcher = defaultFetcher): Promise<{ providerCallId: string; status: DeskCallStatus; raw: Record<string, unknown> }> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(input.config.accountSid)}/Calls.json`
  const body: Record<string, string> = {
    To: input.toNumber,
    From: input.config.fromNumber,
    Url: input.config.twimlUrl,
    StatusCallbackEvent: 'initiated ringing answered completed',
    StatusCallback: input.config.webhookUrl ?? '',
    StatusCallbackMethod: 'POST',
  }
  if (!body.StatusCallback) delete body.StatusCallback
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basicAuth(input.config.accountSid, input.authToken)}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'x-reydesk-call-id': input.callId,
    },
    body: encodeForm(body),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300)
    throw new Error(`Twilio rejected call initiation (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  const raw = await response.json() as Record<string, unknown>
  const sid = typeof raw.sid === 'string' ? raw.sid : ''
  if (!sid) throw new Error('Twilio returned no call SID')
  return { providerCallId: sid, status: mapTwilioStatus(typeof raw.status === 'string' ? raw.status : undefined), raw }
}

export function buildTwilioSignatureInput(url: string, params: Record<string, unknown>): string {
  return url + Object.keys(params).sort().map((key) => `${key}${String(params[key] ?? '')}`).join('')
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, unknown>, signature: string | undefined): boolean {
  if (!signature || signature.length > 200) return false
  const expected = createHmac('sha1', authToken).update(buildTwilioSignatureInput(url, params)).digest('base64')
  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(signature)
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

export function parseTwilioWebhook(payload: Record<string, unknown>): {
  eventType: string
  providerCallId?: string
  direction: 'inbound' | 'outbound'
  fromNumber: string
  toNumber: string
  status: DeskCallStatus
  durationSec: number
  startedAt?: string
  ext: Record<string, unknown>
} {
  const status = typeof payload.CallStatus === 'string' ? payload.CallStatus : typeof payload.call_status === 'string' ? payload.call_status : undefined
  const durationValue = payload.CallDuration ?? payload.call_duration ?? 0
  return {
    eventType: `twilio.call.${status ?? 'updated'}`,
    providerCallId: typeof payload.CallSid === 'string' ? payload.CallSid : typeof payload.call_sid === 'string' ? payload.call_sid : undefined,
    direction: typeof payload.Direction === 'string' && payload.Direction.toLowerCase().startsWith('inbound') ? 'inbound' : 'outbound',
    fromNumber: String(payload.From ?? payload.from ?? ''),
    toNumber: String(payload.To ?? payload.to ?? ''),
    status: mapTwilioStatus(status),
    durationSec: Number(durationValue) > 0 ? Math.floor(Number(durationValue)) : 0,
    startedAt: typeof payload.Timestamp === 'string' ? payload.Timestamp : undefined,
    ext: { twilio: { status: status ?? null, accountSid: payload.AccountSid ?? null } },
  }
}

async function defaultFetcher(url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<TwilioFetchResponse> {
  const response = await fetch(url, init)
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  }
}
