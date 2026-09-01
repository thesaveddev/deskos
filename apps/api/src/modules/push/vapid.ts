import { createPrivateKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto'

/** Base64url encode (no padding) — the format Web Push expects everywhere. */
export function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

/** Decode base64url; throws on invalid input. */
export function b64urlDecode(input: string): Buffer {
  const buf = Buffer.from(input, 'base64url')
  if (buf.length === 0 && input.length > 0) throw new Error('invalid base64url value')
  return buf
}

/**
 * Generate a VAPID key pair (RFC 8292): the public key is the raw uncompressed
 * P-256 point (65 bytes); the private key is the DER PKCS8 encoding. Both are
 * base64url strings ready for REYDESK_VAPID_PUBLIC_KEY / REYDESK_VAPID_PRIVATE_KEY.
 */
export function generateVapidKeyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const rawPoint = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65)
  const der = privateKey.export({ format: 'der', type: 'pkcs8' })
  return { publicKey: rawPoint.toString('base64url'), privateKey: der.toString('base64url') }
}

// DER SEC1 ECPrivateKey for prime256v1 without an included public key:
// SEQUENCE { INTEGER 1, OCTET STRING <scalar>, [0] OID 1.2.840.10045.3.1.7 }
const SEC1_PREFIX = Buffer.from('30310201010420', 'hex')
const SEC1_SUFFIX = Buffer.from('a00a06082a8648ce3d030107', 'hex')

/** Import a VAPID private key (PKCS8 DER, or a bare 32-byte P-256 scalar). */
export function importVapidKey(privateKey: string): KeyObject {
  const buf = b64urlDecode(privateKey)
  try {
    return createPrivateKey({ key: buf, format: 'der', type: 'pkcs8' })
  } catch {
    // Not PKCS8 — treat as a bare 32-byte scalar and wrap in SEC1 ECPrivateKey.
    const scalar = buf.length === 33 && buf[0] === 0 ? buf.subarray(1) : buf
    if (scalar.length !== 32) throw new Error('invalid VAPID private key (expected PKCS8 DER or a 32-byte P-256 scalar)')
    return createPrivateKey({
      key: Buffer.concat([SEC1_PREFIX, scalar, SEC1_SUFFIX]),
      format: 'der',
      type: 'sec1',
    })
  }
}

/**
 * Sign a VAPID JWT (ES256) for a push endpoint audience. Returns the complete
 * `t=<token>,k=<publicKey>` value for the Authorization header, plus the
 * unsigned payload for tests.
 */
export function signVapid(
  config: { publicKey: string; privateKey: string; subject: string },
  audience: string,
  expirationSec = 12 * 60 * 60,
): { token: string; unsignedPayload: string } {
  const header = { typ: 'JWT', alg: 'ES256' }
  const now = Math.floor(Date.now() / 1000)
  const claims = { aud: audience, exp: now + expirationSec, sub: config.subject }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`
  const signature = createSign('sha256')
    .update(signingInput)
    .sign({ key: importVapidKey(config.privateKey), dsaEncoding: 'ieee-p1363' })
  return { token: `${signingInput}.${b64url(signature)}`, unsignedPayload: signingInput }
}