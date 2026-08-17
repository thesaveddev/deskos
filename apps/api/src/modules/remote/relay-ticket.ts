import { createHash, createHmac, randomBytes } from 'node:crypto'

export type RelayAudience = 'technician' | 'agent'

interface RelayTicketPayload {
  sid: string
  aud: RelayAudience
  exp: number
  nonce: string
}

function encode(value: string): string {
  return Buffer.from(value).toString('base64url')
}

function signature(secret: string, encodedPayload: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url')
}

export function hashJoinToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function createRelayTicket(
  secret: string,
  sessionId: string,
  audience: RelayAudience,
  ttlSeconds = 300,
): { token: string; hash: string; expiresAt: Date } {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
  const payload: RelayTicketPayload = {
    sid: sessionId,
    aud: audience,
    exp: Math.floor(expiresAt.getTime() / 1000),
    nonce: randomBytes(16).toString('base64url'),
  }
  const encodedPayload = encode(JSON.stringify(payload))
  const token = `${encodedPayload}.${signature(secret, encodedPayload)}`
  return { token, hash: hashJoinToken(token), expiresAt }
}
