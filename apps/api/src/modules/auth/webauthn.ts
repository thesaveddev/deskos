import { randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import type { AppConfig } from '../../config.js'
import { AppError } from '../../core/errors.js'

export interface RegistrationInfo {
  credentialId: string
  publicKey: Uint8Array
  counter: number
  transports?: string[]
}

export interface AuthenticationInfo {
  credentialId: string
  newCounter: number
}

/**
 * Injectable seam around SimpleWebAuthn's crypto so the HTTP flow can be
 * exercised in tests without a real authenticator. The default wraps the real
 * verifiers with the configured origin and RP ID.
 */
export interface WebauthnVerifier {
  verifyRegistration(response: unknown, expectedChallenge: string): Promise<RegistrationInfo>
  verifyAuthentication(response: unknown, expectedChallenge: string, credential: WebAuthnCredential): Promise<AuthenticationInfo>
}

export function createWebauthnVerifier(config: AppConfig): WebauthnVerifier {
  const { origin, rpId } = config.webauthn
  return {
    async verifyRegistration(response, expectedChallenge) {
      const result = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
      })
      if (!result.verified) throw new AppError(400, 'webauthn_registration_failed', 'Could not verify passkey registration')
      return {
        credentialId: result.registrationInfo.credential.id,
        publicKey: result.registrationInfo.credential.publicKey,
        counter: result.registrationInfo.credential.counter,
        transports: result.registrationInfo.credential.transports,
      }
    },
    async verifyAuthentication(response, expectedChallenge, credential) {
      const result = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpId,
        credential,
      })
      if (!result.verified) throw new AppError(401, 'webauthn_assertion_failed', 'Could not verify passkey')
      return { credentialId: result.authenticationInfo.credentialID, newCounter: result.authenticationInfo.newCounter }
    },
  }
}

export async function buildRegistrationOptions(
  config: AppConfig,
  userName: string,
  userID: Uint8Array,
  exclude: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>,
): Promise<{ options: Record<string, unknown>; challenge: string }> {
  const options = await generateRegistrationOptions({
    rpName: config.webauthn.rpName,
    rpID: config.webauthn.rpId,
    userName,
    userID: new Uint8Array(userID),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: exclude,
  })
  return { options: options as unknown as Record<string, unknown>, challenge: options.challenge }
}

export async function buildAuthenticationOptions(
  config: AppConfig,
  allow: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }>,
): Promise<{ options: Record<string, unknown>; challenge: string }> {
  const options = await generateAuthenticationOptions({
    rpID: config.webauthn.rpId,
    allowCredentials: allow,
    userVerification: 'preferred',
  })
  return { options: options as unknown as Record<string, unknown>, challenge: options.challenge }
}

const CHALLENGE_TTL_MS = 5 * 60_000

interface PendingChallenge {
  challenge: string
  userId: string
  expiresAt: number
}

// In-memory, one-time challenge store. Single-instance safe; multi-instance
// deployments will move this into Redis alongside the relay registry.
const challenges = new Map<string, PendingChallenge>()

export function storeChallenge(userId: string, challenge: string): string {
  sweepChallenges()
  const id = randomBytes(24).toString('hex')
  challenges.set(id, { challenge, userId, expiresAt: Date.now() + CHALLENGE_TTL_MS })
  return id
}

export function consumeChallenge(challengeId: string): { challenge: string; userId: string } {
  sweepChallenges()
  const entry = challenges.get(challengeId)
  if (!entry) throw new AppError(400, 'webauthn_challenge_expired', 'Passkey challenge expired; please try again')
  challenges.delete(challengeId)
  return { challenge: entry.challenge, userId: entry.userId }
}

function sweepChallenges(): void {
  const now = Date.now()
  for (const [id, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(id)
  }
}
