import { create } from 'zustand'
import { api, clearTokens, getAccessToken, getActiveTenant, setActiveTenant as persistActiveTenant, setTokens } from './api.js'

export interface Membership {
  tenant: { id: string; slug: string; name: string; branding?: { portalTitle?: string; logoUrl?: string; primaryColor?: string } }
  orgRole: string
  permissions: string[]
}

interface MeResponse {
  user: { id: string; email: string; name: string }
  memberships: Membership[]
}

interface AuthTokens {
  accessToken: string
  refreshToken: string
}

interface AuthState {
  status: 'loading' | 'anon' | 'authed'
  user: MeResponse['user'] | null
  memberships: Membership[]
  activeTenantId: string | null
  hydrate: () => Promise<void>
  applySession: (tokens: AuthTokens) => Promise<void>
  switchTenant: (tenantId: string) => void
  logout: () => Promise<void>
}

async function fetchMe(): Promise<MeResponse> {
  return api<MeResponse>('/me')
}

/** Keep the persisted tenant if it is still a valid membership; else the first. */
function resolveActiveTenant(me: MeResponse): string | null {
  const persisted = getActiveTenant()
  if (persisted && me.memberships.some((m) => m.tenant.id === persisted)) return persisted
  return me.memberships[0]?.tenant.id ?? null
}

export const useAuth = create<AuthState>()((set) => ({
  status: 'loading',
  user: null,
  memberships: [],
  activeTenantId: null,

  hydrate: async () => {
    if (!getAccessToken()) {
      set({ status: 'anon', user: null, memberships: [], activeTenantId: null })
      return
    }
    try {
      const me = await fetchMe()
      const activeTenantId = resolveActiveTenant(me)
      persistActiveTenant(activeTenantId)
      set({ status: 'authed', user: me.user, memberships: me.memberships, activeTenantId })
    } catch {
      clearTokens()
      set({ status: 'anon', user: null, memberships: [], activeTenantId: null })
    }
  },

  applySession: async (tokens) => {
    setTokens(tokens.accessToken, tokens.refreshToken)
    const me = await fetchMe()
    const activeTenantId = resolveActiveTenant(me)
    persistActiveTenant(activeTenantId)
    set({ status: 'authed', user: me.user, memberships: me.memberships, activeTenantId })
  },

  switchTenant: (tenantId) => {
    persistActiveTenant(tenantId)
    set({ activeTenantId: tenantId })
  },

  logout: async () => {
    try {
      const refreshToken = localStorage.getItem('deskos.refreshToken')
      if (refreshToken) {
        await api('/auth/logout', { method: 'POST', body: { refreshToken }, retryOn401: false })
      }
    } catch {
      /* best effort revocation */
    }
    clearTokens()
    set({ status: 'anon', user: null, memberships: [] })
  },
}))
