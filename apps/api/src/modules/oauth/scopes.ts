import { createHash } from 'node:crypto'

/** OAuth scope → ReyDesk permission. Tokens carry resolved permissions. */
export const SCOPE_PERMISSIONS: Record<string, string> = {
  'tickets:read': 'ticket.read',
  'tickets:write': 'ticket.write',
  'devices:read': 'device.read',
  'devices:manage': 'device.manage',
  'audit:read': 'audit.read',
}

export const VALID_SCOPES = Object.keys(SCOPE_PERMISSIONS) as string[]

/** Canonical public-API scope catalog (scope → permission → human description). */
export interface ApiScope {
  scope: string
  permission: string
  description: string
}

export const API_SCOPES: ApiScope[] = [
  { scope: 'tickets:read', permission: 'ticket.read', description: 'List and read tickets in your tenant' },
  { scope: 'tickets:write', permission: 'ticket.write', description: 'Create and update tickets in your tenant' },
  { scope: 'devices:read', permission: 'device.read', description: 'List enrolled devices and their status' },
  { scope: 'devices:manage', permission: 'device.manage', description: 'Manage enrolled devices' },
  { scope: 'audit:read', permission: 'audit.read', description: 'Read the tenant audit log' },
]

export function scopesToPermissions(scopes: string[]): string[] {
  return [...new Set(scopes.map((s) => SCOPE_PERMISSIONS[s]).filter((p): p is string => Boolean(p)))]
}

export function isScopeSubset(requested: string[], allowed: string[]): boolean {
  return requested.every((s) => allowed.includes(s))
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Generate an opaque client secret (returned once). */
export function generateClientSecret(): string {
  return `dsk_${createHash('sha256').update(String(Math.random()) + Date.now() + process.hrtime.bigint()).digest('base64url').slice(0, 32)}`
}

export function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url')
}

/** Verify a PKCE S256 code_verifier against a stored code_challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  try {
    return sha256Base64Url(verifier) === challenge
  } catch {
    return false
  }
}
