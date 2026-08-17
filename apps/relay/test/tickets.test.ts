import { describe, expect, it } from 'vitest'
import { InMemoryTicketStore, signTicket, ticketHash, verifyTicket, type RelayTicket } from '../src/tickets.js'

const secret = 'unit-test-relay-secret-0123456789abcdef'

function ticket(overrides: Partial<RelayTicket> = {}): RelayTicket {
  return {
    sid: '00000000-0000-4000-8000-000000000001',
    aud: 'technician',
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: 'test-nonce',
    ...overrides,
  }
}

describe('relay ticket verification', () => {
  it('round-trips a signed ticket', () => {
    const signed = signTicket(secret, ticket())
    expect(verifyTicket(secret, signed)).toEqual(ticket())
  })

  it('rejects a tampered payload', () => {
    const original = ticket()
    const signed = signTicket(secret, original)
    const [payload, signature] = signed.split('.')
    const tamperedPayload = Buffer.from(JSON.stringify({ ...original, sid: '11111111-1111-4111-8111-111111111111' })).toString('base64url')
    expect(verifyTicket(secret, `${tamperedPayload}.${signature}`)).toBeNull()
  })

  it('rejects a ticket signed with the wrong secret', () => {
    const signed = signTicket(secret, ticket())
    expect(verifyTicket('a-different-secret', signed)).toBeNull()
  })

  it('rejects an expired ticket', () => {
    const signed = signTicket(secret, ticket({ exp: Math.floor(Date.now() / 1000) - 1 }))
    expect(verifyTicket(secret, signed)).toBeNull()
  })

  it('rejects an invalid audience', () => {
    const signed = signTicket(secret, ticket({ aud: 'attacker' as never }))
    expect(verifyTicket(secret, signed)).toBeNull()
  })

  it('rejects malformed tokens', () => {
    expect(verifyTicket(secret, 'not-a-token')).toBeNull()
    expect(verifyTicket(secret, 'only.payload')).toBeNull()
    expect(verifyTicket(secret, '.')).toBeNull()
    expect(verifyTicket(secret, 'a.b.c')).toBeNull()
  })

  it('hashes tokens deterministically for the registry', () => {
    const signed = signTicket(secret, ticket())
    expect(ticketHash(signed)).toBe(ticketHash(signed))
    expect(ticketHash(signed)).not.toBe(ticketHash(signTicket(secret, ticket({ nonce: 'other' }))))
  })
})

describe('in-memory single-use ticket store', () => {
  it('allows the first consumption and rejects reuse within the window', () => {
    const store = new InMemoryTicketStore()
    const token = signTicket(secret, ticket())
    const now = Date.now()
    const expiresAt = now + 60_000
    expect(store.consume(token, expiresAt, now)).toBe(true)
    expect(store.consume(token, expiresAt, now)).toBe(false)
  })

  it('clears lapsed entries so fresh tokens are always accepted', () => {
    const store = new InMemoryTicketStore()
    store.consume('expired-token', 1000)
    expect(store.consume('fresh-token', Date.now() + 60_000, Date.now() + 10_000)).toBe(true)
  })
})
