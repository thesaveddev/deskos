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

  // PRK = HKDF-Extract(salt, shared_secret)
  const prk = hkdf(sharedSecret, salt, EMPTY, 32)
  // IKM = HKDF-Expand(PRK, "Content-Encoding: auth" || 0x00 || auth_secret, 32)
  const ikm = hkdf(prk, EMPTY, Buffer.concat([Buffer.from('Content-Encoding: auth\0'), subscriberAuth]), 32)
  // PRK_key = HKDF-Extract(IKM, shared_secret)
  const prkKey = hkdf(sharedSecret, ikm, EMPTY, 32)
  // key_info = "WebPush: info" || 0x00 || ua_public || as_public
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), subscriberPublicKey, serverPublicKey])
  const cek = hkdf(prkKey, EMPTY, keyInfo, 16)
  const nonce = hkdf(prkKey, EMPTY, keyInfo, 12)

  // Record: 0x02 delimiter + plaintext + zero padding to a multiple of 16.
  const payload = Buffer.concat([Buffer.from([0x02]), plaintext])
  const padded = Buffer.concat([payload, Buffer.alloc((16 - (payload.length % 16)) % 16)])

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096, 0)
  return Buffer.concat([salt, recordSize, Buffer.from([65]), serverPublicKey, ciphertext])
}