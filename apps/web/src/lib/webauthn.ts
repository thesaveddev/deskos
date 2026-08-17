import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser'
import { api } from './api.js'

export interface PasskeyCredential {
  id: string
  device_name: string
  created_at: string
  last_used_at: string | null
}

export interface LoginResult {
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
}

interface RegisterBegin {
  challengeId: string
  options: Record<string, unknown>
}

interface AssertBegin {
  available: boolean
  challengeId?: string
  options?: Record<string, unknown>
}

/** Register a passkey for the signed-in user. */
export async function registerPasskey(deviceName?: string): Promise<PasskeyCredential> {
  const begin = await api<RegisterBegin>('/auth/webauthn/register/begin', { method: 'POST', body: {} })
  const response = await startRegistration({ optionsJSON: begin.options as unknown as PublicKeyCredentialCreationOptionsJSON })
  const complete = await api<{ credential: PasskeyCredential }>('/auth/webauthn/register/complete', {
    method: 'POST',
    body: { challengeId: begin.challengeId, response, deviceName },
  })
  return complete.credential
}

export function listPasskeys(): Promise<{ credentials: PasskeyCredential[] }> {
  return api('/auth/webauthn/credentials')
}

export function removePasskey(id: string): Promise<{ ok: boolean }> {
  return api(`/auth/webauthn/credentials/${id}`, { method: 'DELETE' })
}

/**
 * Try passkey login after email+password. Returns `{ available: false }` when
 * the account has no passkey, or the full session when assertion succeeds.
 */
export async function assertPasskey(email: string, password: string): Promise<AssertBegin | LoginResult> {
  const begin = await api<AssertBegin>('/auth/webauthn/assert/begin', {
    method: 'POST',
    body: { email, password },
    auth: false,
    retryOn401: false,
  })
  if (!begin.available) return begin
  const response = await startAuthentication({ optionsJSON: begin.options as unknown as PublicKeyCredentialRequestOptionsJSON })
  return api<LoginResult>('/auth/webauthn/assert/complete', {
    method: 'POST',
    body: { challengeId: begin.challengeId, response },
    auth: false,
    retryOn401: false,
  })
}
