import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export interface RelayTicket {
  sid: string
  aud: 'technician' | 'agent'
  exp: number
  nonce: string
}

export function signTicket(secret: string, ticket: RelayTicket): string {
  const encodedPayload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  return `${encodedPayload}.${signature}`
}

export function verifyTicket(secret: string, token: string, now = Date.now()): RelayTicket | null {
  const [encodedPayload, encodedSignature] = token.split('.')
  if (!encodedPayload || !encodedSignature) return null
  let payload: RelayTicket
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as RelayTicket
  } catch {
    return null
  }
  if (!payload.sid || !payload.nonce || !['technician', 'agent'].includes(payload.aud) || payload.exp * 1000 <= now) return null
  const expected = createHmac('sha256', secret).update(encodedPayload).digest('base64url')
  const actual = Buffer.from(encodedSignature)
  const expectedBuffer = Buffer.from(expected)
  if (actual.length !== expectedBuffer.length || !timingSafeEqual(actual, expectedBuffer)) return null
  return payload
}

export function ticketHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** In-memory single-use ticket store used when Redis is not configured. */
export class InMemoryTicketStore {
  private used = new Map<string, number>()

  consume(token: string, expiresAt: number, now = Date.now()): boolean {
    for (const [usedToken, expiry] of this.used) {
      if (expiry <= now) this.used.delete(usedToken)
    }
    if (this.used.has(token)) return false
    this.used.set(token, expiresAt)
    return true
  }
}
