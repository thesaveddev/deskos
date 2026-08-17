import { api } from './api.js'

export type AssetType = 'hardware' | 'mobile' | 'network' | 'peripheral' | 'cloud' | 'software' | 'other'
export type AssetStatus = 'in_use' | 'available' | 'in_repair' | 'retired' | 'lost'

export interface Asset {
  id: string
  tag: string
  type: AssetType
  name: string
  status: AssetStatus
  owner_id: string | null
  owner_name?: string | null
  location: string | null
  supplier: string | null
  warranty_until: string | null
  purchase: Record<string, unknown>
  device_id: string | null
  device_name?: string | null
  ext: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface Licence {
  id: string
  asset_id: string | null
  name: string
  key_ref: string
  seats_used: number
  seats_total: number
  expires_at: string | null
  created_at: string
  updated_at: string
}

export function listAssets(params: { q?: string; type?: AssetType; status?: AssetStatus } = {}): Promise<{ assets: Asset[] }> {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.type) query.set('type', params.type)
  if (params.status) query.set('status', params.status)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/assets${suffix}`)
}

export function getAsset(id: string): Promise<{ asset: Asset; licences: Licence[] }> {
  return api(`/assets/${id}`)
}

export function createAsset(body: {
  tag: string
  type: AssetType
  name: string
  status?: AssetStatus
  ownerId?: string
  location?: string
  supplier?: string
  warrantyUntil?: string
  purchase?: Record<string, unknown>
  deviceId?: string
  ext?: Record<string, unknown>
}): Promise<{ asset: Asset }> {
  return api('/assets', { method: 'POST', body })
}

export function updateAsset(id: string, body: Partial<{
  tag: string
  type: AssetType
  name: string
  status: AssetStatus
  ownerId: string | null
  location: string | null
  supplier: string | null
  warrantyUntil: string | null
  purchase: Record<string, unknown>
  deviceId: string | null
  ext: Record<string, unknown>
}>): Promise<{ asset: Asset }> {
  return api(`/assets/${id}`, { method: 'PATCH', body })
}

export function deleteAsset(id: string): Promise<{ ok: boolean }> {
  return api(`/assets/${id}`, { method: 'DELETE' })
}

export function listLicences(assetId?: string): Promise<{ licences: Licence[] }> {
  const suffix = assetId ? `?assetId=${encodeURIComponent(assetId)}` : ''
  return api(`/licences${suffix}`)
}

export function createLicence(body: {
  assetId?: string
  name: string
  keyRef?: string
  seatsUsed?: number
  seatsTotal?: number
  expiresAt?: string
}): Promise<{ licence: Licence }> {
  return api('/licences', { method: 'POST', body })
}

export function updateLicence(id: string, body: Partial<{
  assetId: string | null
  name: string
  keyRef: string
  seatsUsed: number
  seatsTotal: number
  expiresAt: string | null
}>): Promise<{ licence: Licence }> {
  return api(`/licences/${id}`, { method: 'PATCH', body })
}

export function deleteLicence(id: string): Promise<{ ok: boolean }> {
  return api(`/licences/${id}`, { method: 'DELETE' })
}
