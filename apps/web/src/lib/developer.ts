import { api } from './api.js'

export interface ApiScope {
  scope: string
  permission: string
  description: string
}

export interface DeveloperOverview {
  baseUrl: string
  specUrl: string
  auth: {
    tokenUrl: string
    authorizeUrl: string
    grantTypes: string[]
  }
  endpoints: Array<{ method: string; path: string; scope: string; description: string }>
  scopes: ApiScope[]
}

export function getDeveloperOverview(): Promise<DeveloperOverview> {
  return api('/developer/overview')
}
