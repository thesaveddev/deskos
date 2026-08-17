import { api } from './api.js'

export type DeviceStatus = 'online' | 'offline' | 'never'

export interface Device {
  id: string
  tenant_id?: string
  group_id: string | null
  group_name?: string | null
  name: string
  hostname: string
  os: string
  os_version: string
  arch: string
  ip_address: string
  agent_version: string
  enrolled_at: string
  last_seen_at: string | null
  created_at: string
  updated_at?: string
  status: DeviceStatus
  agent_token_hash?: string | null
}

export interface DeviceMetric {
  id: number
  cpu_pct: number
  mem_pct: number
  disk_pct: number
  recorded_at: string
}

export interface DeviceAlert {
  id: string
  device_id: string
  device_name?: string
  kind: string
  severity: 'info' | 'warning' | 'critical'
  message: string
  ticket_id: string | null
  ticket_number?: number | null
  resolved_at: string | null
  created_at: string
}

export interface DeviceTicket {
  id: string
  number: number
  subject: string
  status: string
  priority: string
  created_at: string
}

export interface DeviceGroup {
  id: string
  name: string
  parent_id: string | null
  parent_name?: string | null
  match_rules: unknown[]
  device_count: number
  created_at: string
}

export interface DeviceDetailResponse {
  device: Device
  metrics: DeviceMetric[]
  alerts: DeviceAlert[]
  tickets: DeviceTicket[]
}

export function listDevices(params: { q?: string; groupId?: string; status?: DeviceStatus } = {}): Promise<{ devices: Device[] }> {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.groupId) query.set('groupId', params.groupId)
  if (params.status) query.set('status', params.status)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/devices${suffix}`)
}

export function getDevice(id: string): Promise<DeviceDetailResponse> {
  return api(`/devices/${id}`)
}

export function listDeviceGroups(): Promise<{ groups: DeviceGroup[] }> {
  return api('/device-groups')
}

export function updateDevice(id: string, body: { name?: string; groupId?: string | null }): Promise<{ device: Device }> {
  return api(`/devices/${id}`, { method: 'PATCH', body })
}

export function deleteDevice(id: string): Promise<{ ok: true }> {
  return api(`/devices/${id}`, { method: 'DELETE' })
}

export function createDeviceGroup(body: { name: string; parentId?: string; matchRules?: unknown[] }): Promise<{ group: DeviceGroup }> {
  return api('/device-groups', { method: 'POST', body })
}

export function updateDeviceGroup(id: string, body: { name?: string; parentId?: string | null; matchRules?: unknown[] }): Promise<{ group: DeviceGroup }> {
  return api(`/device-groups/${id}`, { method: 'PATCH', body })
}

export function deleteDeviceGroup(id: string): Promise<{ ok: true }> {
  return api(`/device-groups/${id}`, { method: 'DELETE' })
}

export function getEnrolToken(): Promise<{
  activeToken: { label: string; createdAt: string } | null
  activeCode: { createdAt: string; expiresAt: string } | null
}> {
  return api('/devices/enrol-token')
}

export function rotateEnrolToken(): Promise<{ token: string; code: string; codeExpiresAt: string; note: string }> {
  return api('/devices/enrol-token/rotate', { method: 'POST', body: {} })
}
