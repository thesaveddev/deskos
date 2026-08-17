import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest()
}

/** Encrypt a secret to a self-contained "v1:<iv>:<tag>:<ciphertext>" string. */
export function encryptSecret(secret: string, key: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, deriveKey(key), iv)
  const ct = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

/** Decrypt a value produced by encryptSecret. */
export function decryptSecret(payload: string, key: string): string {
  const [version, ivHex, tagHex, ctHex] = payload.split(':')
  if (version !== 'v1' || !ivHex || !tagHex || !ctHex) {
    throw new Error('invalid encrypted payload')
  }
  const decipher = createDecipheriv(ALGO, deriveKey(key), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const plain = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
  return plain.toString('utf8')
}

/** Return a payload safe for API responses: never expose the plaintext. */
export function maskSecret(): string {
  return '••••••••••••'
}

export function isEncryptedSecret(payload: string): boolean {
  return payload.startsWith('v1:')
}