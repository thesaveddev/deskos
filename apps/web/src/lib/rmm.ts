import { api } from './api.js'

export type DeviceActionKind = 'restart' | 'run_script' | 'collect_inventory'

export interface EndpointPolicy {
  id: string
  name: string
  group_id: string | null
  group_name: string | null
  posture_checks: unknown[]
  reboot_window: Record<string, unknown>
  enabled: boolean
  created_at: string
}

export interface DeviceAction {
  id: string
  device_id: string
  device_name: string
  action: DeviceActionKind
  payload: Record<string, unknown>
  status: 'pending' | 'dispatched' | 'succeeded' | 'failed' | 'cancelled'
  requested_by_name: string | null
  created_at: string
  completed_at: string | null
  result: Record<string, unknown>
}

export interface DeviceInventory {
  device_id: string
  hardware: Record<string, unknown>
  os: Record<string, unknown>
  apps: unknown[]
  security_posture: Record<string, unknown>
  collected_at: string
}

export function listPolicies(): Promise<{ policies: EndpointPolicy[] }> {
  return api('/endpoint-policies')
}

export function createPolicy(body: { name: string; groupId?: string | null; postureChecks?: unknown[]; rebootWindow?: Record<string, unknown>; enabled?: boolean }): Promise<{ policy: EndpointPolicy }> {
  return api('/endpoint-policies', { method: 'POST', body })
}

export function updatePolicy(id: string, body: Partial<{ name: string; groupId: string | null; enabled: boolean }>): Promise<{ policy: EndpointPolicy }> {
  return api(`/endpoint-policies/${id}`, { method: 'PATCH', body })
}

export function deletePolicy(id: string): Promise<{ ok: boolean }> {
  return api(`/endpoint-policies/${id}`, { method: 'DELETE' })
}

export function listDeviceActions(status?: string): Promise<{ actions: DeviceAction[] }> {
  return api(`/devices/actions${status ? `?status=${status}` : ''}`)
}

export function queueDeviceActions(body: { action: DeviceActionKind; payload?: Record<string, unknown>; deviceIds?: string[]; groupId?: string }): Promise<{ created: number }> {
  return api('/devices/actions', { method: 'POST', body })
}

export function getDeviceInventory(id: string): Promise<{ inventory: DeviceInventory }> {
  return api(`/devices/${id}/inventory`)
}
