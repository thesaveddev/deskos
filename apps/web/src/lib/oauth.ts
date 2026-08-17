import { api } from './api.js'

export interface OAuthClient {
  id: string
  name: string
  redirectUris: string[]
  scopes: string[]
  grantTypes: string[]
  enabled: boolean
  createdAt: string
}

export function listOauthClients(): Promise<{ clients: OAuthClient[] }> {
  return api('/oauth/clients')
}

export function createOauthClient(body: {
  name: string
  redirectUris?: string[]
  scopes?: string[]
  grantTypes?: ('client_credentials' | 'authorization_code')[]
  enabled?: boolean
}): Promise<{ client: OAuthClient; clientSecret: string }> {
  return api('/oauth/clients', { method: 'POST', body })
}

export function deleteOauthClient(id: string): Promise<{ ok: boolean }> {
  return api(`/oauth/clients/${id}`, { method: 'DELETE' })
}
