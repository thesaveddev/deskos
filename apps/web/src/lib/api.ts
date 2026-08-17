export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly deniedReason?: string

  constructor(status: number, code: string, message: string, deniedReason?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.deniedReason = deniedReason
  }
}

const TOKEN_KEY = 'deskos.accessToken'
const REFRESH_KEY = 'deskos.refreshToken'
const TENANT_KEY = 'deskos.activeTenant'

export function getAccessToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_KEY)
}

export function setTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(TOKEN_KEY, accessToken)
  localStorage.setItem(REFRESH_KEY, refreshToken)
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(REFRESH_KEY)
}

/** The tenant every tenant-scoped request is scoped to (sent as X-DeskOS-Tenant). */
export function getActiveTenant(): string | null {
  return localStorage.getItem(TENANT_KEY)
}

export function setActiveTenant(tenantId: string | null): void {
  if (tenantId) localStorage.setItem(TENANT_KEY, tenantId)
  else localStorage.removeItem(TENANT_KEY)
}

interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  auth?: boolean
  tenant?: string
  retryOn401?: boolean
}

async function parseError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; denied_reason?: string }
    }
    return new ApiError(
      res.status,
      body.error?.code ?? 'unknown',
      body.error?.message ?? `Request failed (${res.status})`,
      body.error?.denied_reason,
    )
  } catch {
    return new ApiError(res.status, 'unknown', `Request failed (${res.status})`)
  }
}

let refreshInFlight: Promise<boolean> | null = null

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken()
  if (!refreshToken) return false
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch('/api/v1/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        })
        if (!res.ok) {
          clearTokens()
          return false
        }
        const body = (await res.json()) as { accessToken: string; refreshToken: string }
        setTokens(body.accessToken, body.refreshToken)
        return true
      } catch {
        return false
      } finally {
        setTimeout(() => {
          refreshInFlight = null
        }, 0)
      }
    })()
  }
  return refreshInFlight
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, tenant, retryOn401 = true } = options

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (auth) {
    const token = getAccessToken()
    if (token) headers.authorization = `Bearer ${token}`
    if (tenant) headers['x-deskos-tenant'] = tenant
    else {
      const active = getActiveTenant()
      if (active) headers['x-deskos-tenant'] = active
    }
  }

  const res = await fetch(`/api/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  if (res.status === 401 && auth && retryOn401 && getRefreshToken()) {
    const refreshed = await tryRefresh()
    if (refreshed) {
      headers.authorization = `Bearer ${getAccessToken()}`
      const retry = await fetch(`/api/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (!retry.ok) throw await parseError(retry)
      return (await retry.json()) as T
    }
  }

  if (!res.ok) throw await parseError(res)
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
