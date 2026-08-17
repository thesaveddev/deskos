import { api } from './api.js'

export interface AppRegistryEntry {
  id: string
  name: string
  slug: string
  description: string
  developer: string
  version: string
  icon_url: string | null
  capabilities: string[]
  install_count: number
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AppInstall {
  id: string
  tenant_id: string
  app_id: string
  installed_by: string
  enabled: boolean
  config: Record<string, unknown>
  installed_at: string
  updated_at: string
  app_name: string
  app_slug: string
  app_description: string
  app_developer: string
  app_version: string
  app_icon_url: string | null
  app_capabilities: string[]
}

export async function listApps(): Promise<AppRegistryEntry[]> {
  return api('/marketplace/apps') as Promise<AppRegistryEntry[]>
}

export async function getApp(slug: string): Promise<AppRegistryEntry> {
  return api(`/marketplace/apps/${slug}`) as Promise<AppRegistryEntry>
}

export async function createApp(data: {
  name: string
  slug: string
  description?: string
  developer?: string
  version?: string
  icon_url?: string | null
  capabilities?: string[]
}): Promise<AppRegistryEntry> {
  return api('/marketplace/apps', { method: 'POST', body: data }) as Promise<AppRegistryEntry>
}

export async function updateApp(slug: string, data: Partial<{
  name: string
  description: string
  developer: string
  version: string
  icon_url: string | null
  capabilities: string[]
}>): Promise<AppRegistryEntry> {
  return api(`/marketplace/apps/${slug}`, { method: 'PATCH', body: data }) as Promise<AppRegistryEntry>
}

export async function deleteApp(slug: string): Promise<void> {
  await api(`/marketplace/apps/${slug}`, { method: 'DELETE' })
}

export async function listInstalls(): Promise<AppInstall[]> {
  return api('/marketplace/installs') as Promise<AppInstall[]>
}

export async function installApp(appId: string, config?: Record<string, unknown>): Promise<AppInstall> {
  return api(`/marketplace/installs/${appId}`, { method: 'POST', body: { config: config ?? {} } }) as Promise<AppInstall>
}

export async function uninstallApp(appId: string): Promise<void> {
  await api(`/marketplace/installs/${appId}`, { method: 'DELETE' })
}

export async function toggleInstall(appId: string, enabled: boolean): Promise<AppInstall> {
  return api(`/marketplace/installs/${appId}/toggle`, { method: 'PATCH', body: { enabled } }) as Promise<AppInstall>
}
