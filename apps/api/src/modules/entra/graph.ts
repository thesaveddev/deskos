import { AppError } from '../../core/errors.js'

/**
 * Microsoft Graph client used by the Entra integration. The implementation is
 * injectable so tests can drive it without real Azure credentials; the HTTP
 * transport (client-credentials token exchange + Graph calls) lives in
 * `graphClient` and is only exercised when a connection is enabled and used.
 */
export interface EntraUser {
  objectId: string
  upn: string
  displayName: string
  mail?: string
  department?: string
  jobTitle?: string
  employeeId?: string
  accountEnabled: boolean
  mfaRegistered?: boolean
}

/** A device discovered from Entra/Intune (inventory only; no agent). */
export interface EntraDevice {
  objectId: string
  name: string
  os: string
  osVersion: string
  serialNumber?: string
  manufacturer?: string
  model?: string
  lastSyncDateTime?: string
}

export interface EntraGraphClient {
  /** List tenant users (the production impl pages through `/v1.0/users`). */
  listUsers(connection: EntraConnectionSecrets): Promise<EntraUser[]>
  /** List managed devices from Intune (`/deviceManagement/managedDevices`). */
  listDevices(connection: EntraConnectionSecrets): Promise<EntraDevice[]>
  /** Perform a gated account action, returning a short human-readable result. */
  runAccountAction(
    connection: EntraConnectionSecrets,
    action: 'resetPassword' | 'requireMfa',
    upn: string,
    newPassword?: string,
  ): Promise<string>
}

export interface EntraConnectionSecrets {
  azureTenantId: string
  clientId: string
  clientSecret: string
}

/**
 * Production client: OAuth2 client-credentials flow against
 * `login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, then Graph.
 */
export const graphClient: EntraGraphClient = {
  async listUsers(connection) {
    const token = await acquireToken(connection)
    const users = await graphGet<{ value: Array<Record<string, unknown>> }>(token, '/v1.0/users?$top=200&$select=id,userPrincipalName,displayName,mail,department,jobTitle,employeeId,accountEnabled')
    return users.value.map((u) => ({
      objectId: String(u.id ?? ''),
      upn: String(u.userPrincipalName ?? u.mail ?? ''),
      displayName: String(u.displayName ?? ''),
      mail: u.mail ? String(u.mail) : undefined,
      department: u.department ? String(u.department) : undefined,
      jobTitle: u.jobTitle ? String(u.jobTitle) : undefined,
      employeeId: u.employeeId ? String(u.employeeId) : undefined,
      accountEnabled: u.accountEnabled !== false,
    }))
  },
  async listDevices(connection) {
    const token = await acquireToken(connection)
    const devices = await graphGet<{ value: Array<Record<string, unknown>> }>(token, '/v1.0/deviceManagement/managedDevices?$top=200&$select=id,deviceName,serialNumber,manufacturer,model,operatingSystem,osVersion,lastSyncDateTime')
    return devices.value.map((d) => ({
      objectId: String(d.id ?? ''),
      name: String(d.deviceName ?? ''),
      os: String(d.operatingSystem ?? ''),
      osVersion: String(d.osVersion ?? ''),
      serialNumber: d.serialNumber ? String(d.serialNumber) : undefined,
      manufacturer: d.manufacturer ? String(d.manufacturer) : undefined,
      model: d.model ? String(d.model) : undefined,
      lastSyncDateTime: d.lastSyncDateTime ? String(d.lastSyncDateTime) : undefined,
    }))
  },
  async runAccountAction(connection, action, upn, newPassword) {
    const token = await acquireToken(connection)
    const userPath = `/v1.0/users/${encodeURIComponent(upn)}`
    if (action === 'resetPassword') {
      if (!newPassword) throw new AppError(400, 'new_password_required', 'A new password is required')
      // Set a new password and force the user to change it at next sign-in.
      await graphPatch(token, userPath, {
        passwordProfile: { password: newPassword, forceChangePasswordNextSignIn: true },
      })
      return 'Password reset and force-change-next-sign-in requested'
    }
    // requireMfa: per-user MFA "enforced" state via the legacy strong-auth
    // requirement (the modern replacement is Conditional Access policy).
    await graphPatch(token, userPath, {
      strongAuthenticationRequirement: { state: 'enforced' },
    })
    return 'MFA enforcement requested'
  },
}

async function acquireToken(connection: EntraConnectionSecrets): Promise<string> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(connection.azureTenantId)}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: connection.clientId,
    client_secret: connection.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  })
  const res = await fetch(url, { method: 'POST', body })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError(502, 'entra_auth_failed', `Microsoft identity rejected the credentials (${res.status}): ${text.slice(0, 300)}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) throw new AppError(502, 'entra_auth_failed', 'Microsoft identity returned no access token')
  return json.access_token
}

async function graphGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError(502, 'entra_graph_failed', `Microsoft Graph rejected the request (${res.status}): ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

async function graphPatch(token: string, path: string, payload: unknown): Promise<void> {
  const res = await fetch(`https://graph.microsoft.com${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AppError(502, 'entra_graph_failed', `Microsoft Graph rejected the request (${res.status}): ${text.slice(0, 300)}`)
  }
}
