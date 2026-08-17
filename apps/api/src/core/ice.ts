import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IceConfig } from '../config.js'

export interface IceServerEntry {
  urls: string | string[]
  username?: string
  credential?: string
}

/**
 * coturn REST-API credential format (`use-auth-secret`): the username is
 * `<unix-expiry>:<user>` and the credential is the base64-encoded HMAC-SHA1 of
 * the username keyed with the shared secret. coturn verifies both and rejects
 * credentials past their expiry, so no state is kept on the API side.
 */
export function mintTurnCredential(config: IceConfig): { username: string; credential: string } {
  const expiry = Math.floor(Date.now() / 1000) + config.turnTtlSec
  const username = `${expiry}:${config.turnUsername}`
  const credential = createHmac('sha1', config.turnSharedSecret).update(username).digest('base64')
  return { username, credential }
}

/** Build the ICE servers handed to the browser (`RTCConfiguration.iceServers`). */
export function buildIceServers(config: IceConfig): IceServerEntry[] {
  const servers: IceServerEntry[] = config.stunUrls.map((urls) => ({ urls }))
  if (config.turnUrls.length === 0) return servers

  const { username, credential } = mintTurnCredential(config)
  for (const urls of config.turnUrls) {
    servers.push({ urls, username, credential })
  }
  return servers
}

/**
 * Verify a credential the way coturn's `static-auth-secret` does. This is used
 * by the tests to prove the minted credentials are valid, not by the API at
 * runtime (coturn itself performs the check).
 */
export function verifyTurnCredential(
  secret: string,
  username: string,
  credential: string,
): boolean {
  const [expiryText] = username.split(':')
  const expiry = Number(expiryText)
  if (!Number.isFinite(expiry)) return false
  if (expiry * 1000 < Date.now()) return false

  const expected = createHmac('sha1', secret).update(username).digest()
  let received: Buffer
  try {
    received = Buffer.from(credential, 'base64')
  } catch {
    return false
  }
  return expected.length === received.length && timingSafeEqual(expected, received)
}
