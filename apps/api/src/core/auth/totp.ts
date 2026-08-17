import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/g, '').replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(msg).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

export interface TotpOptions {
  periodSec?: number
  digits?: number
  window?: number
}

export function totpAt(secretBase32: string, timestampMs: number, opts: TotpOptions = {}): string {
  const period = opts.periodSec ?? 30
  const counter = Math.floor(timestampMs / 1000 / period)
  const raw = hotp(base32Decode(secretBase32), counter)
  const digits = opts.digits ?? 6
  return raw.slice(-digits)
}

export function verifyTotp(
  token: string,
  secretBase32: string,
  opts: TotpOptions = {},
  nowMs: number = Date.now(),
): boolean {
  const window = opts.window ?? 1
  const normalized = token.replace(/\s+/g, '')
  if (!/^\d{6,8}$/.test(normalized)) return false
  const tokenBuf = Buffer.from(normalized)
  for (let offset = -window; offset <= window; offset++) {
    const period = opts.periodSec ?? 30
    const counter = Math.floor(nowMs / 1000 / period) + offset
    const expected = hotp(base32Decode(secretBase32), counter).slice(-(opts.digits ?? 6))
    const expectedBuf = Buffer.from(expected)
    if (tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf)) {
      return true
    }
  }
  return false
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
