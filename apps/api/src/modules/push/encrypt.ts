import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'

const EMPTY = Buffer.alloc(0)

/** hkdfSync returns ArrayBuffer on newer Node types — normalise to Buffer. */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/**
 * Encrypt a push payload for a subscriber's keys per RFC 8291 (aes128gcm).
 * `subscriberPublicKey` is the 65-byte uncompressed P-256 point, `subscriberAuth`
 * the 16-byte auth secret, both decoded from the subscription's base64url keys.
 * Returns the full body (salt ‖ record-size ‖ key-id-length ‖ public-key ‖
 * ciphertext) ready to POST with `Content-Encoding: aes128gcm`.
 */
export function encryptWebPushPayload(
  plaintext: Buffer,
  subscriberPublicKey: Buffer,
  subscriberAuth: Buffer,
): Buffer {
  const salt = randomBytes(16)
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const serverPublicKey = ecdh.getPublicKey() // 65-byte uncompressed point
  const sharedSecret = ecdh.computeSecret(subscriberPublicKey)

  // RFC 8291 / aes128gcm key schedule:
  // PRK_key = HKDF-Extract(auth_secret, ECDH secret)
  const prkKey = hkdf(sharedSecret, subscriberAuth, EMPTY, 32)
  // IKM = HKDF-Expand(PRK_key, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPublicKey, serverPublicKey])
  const ikm = hkdf(prkKey, EMPTY, keyInfo, 32)
  // PRK = HKDF-Extract(salt, IKM)
  const prk = hkdf(ikm, salt, EMPTY, 32)
  const cek = hkdf(prk, EMPTY, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(prk, EMPTY, Buffer.from('Content-Encoding: nonce\0'), 12)

  // The record size includes the 16-byte GCM tag. The 0x02 delimiter is the
  // final byte, after zero padding, so the browser can strip padding safely.
  const recordSizeValue = 4096
  const paddingLength = recordSizeValue - 16 - plaintext.length - 1
  if (paddingLength < 0) throw new Error('push payload is too large for a single aes128gcm record')
  const padded = Buffer.concat([plaintext, Buffer.alloc(paddingLength), Buffer.from([0x02])])

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(recordSizeValue, 0)
  // aes128gcm records include the 16-byte GCM authentication tag. Omitting it
  // produces a request that the browser push service accepts but cannot
  // decrypt, which makes notifications appear to disappear silently.
  return Buffer.concat([salt, recordSize, Buffer.from([65]), serverPublicKey, ciphertext])
}