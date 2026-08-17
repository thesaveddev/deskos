import { api } from './api.js'

export interface Branding {
  portalTitle?: string
  logoUrl?: string
  primaryColor?: string
}

export interface MspTenant {
  id: string
  name: string
  slug: string
  region: string
  orgRole: string
  branding: Branding
  stats: {
    openTickets: number
    deviceCount: number
    activeSessions: number
  }
}

export function mspConsole(): Promise<{ tenants: MspTenant[] }> {
  return api('/msp/console')
}

export function updateBranding(body: {
  portalTitle?: string | null
  logoUrl?: string | null
  primaryColor?: string | null
}): Promise<{ branding: Branding }> {
  return api('/tenant/branding', { method: 'PATCH', body })
}
