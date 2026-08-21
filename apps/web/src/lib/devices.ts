import { api } from './api.js'

export type DeviceStatus = 'online' | 'offline' | 'never'
export type DeviceType = 'laptop' | 'workstation' | 'server' | 'network_device' | 'mobile' | 'other'

export interface Device {
  id: string
  tenant_id?: string
  group_id: string | null
  group_name?: string | null
  asset_tag?: string | null
  assignment_status?: AssignmentStatus | null
  assigned_user_name?: string | null
  name: string
  hostname: string
  os: string
  os_version: string
  arch: string
  ip_address: string
  agent_version: string
  device_type?: DeviceType
  power_source?: string
  battery_pct?: number | null
  battery_health_pct?: number | null
  uptime_seconds?: number | null
  last_inventory_at?: string | null
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
  disk_free_bytes?: number | null
  network_latency_ms?: number | null
  network_packet_loss_pct?: number | null
  battery_pct?: number | null
  battery_health_pct?: number | null
  uptime_seconds?: number | null
  process_count?: number | null
  service_states?: Record<string, string>
  recorded_reason?: string
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
  acknowledged_at?: string | null
  acknowledged_by?: string | null
  snoozed_until?: string | null
  escalation_level?: number
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

export type AssignmentStatus = 'assigned' | 'shared' | 'temporary' | 'returned'

export interface DeviceAssignment {
  id: string
  device_id: string
  user_id: string | null
  user_name?: string | null
  user_email?: string | null
  assigned_by?: string | null
  assigned_by_name?: string | null
  assigned_at: string
  returned_at?: string | null
  ended_at?: string | null
  expected_return_at?: string | null
  assignment_status: AssignmentStatus
  department: string
  team_id?: string | null
  team_name?: string | null
  location: string
  reason: string
  notes: string
}

export interface DeviceAssetIdentity {
  id: string
  tag: string
  name: string
  type: string
  status: string
  qr_payload?: string | null
  barcode_value?: string | null
  warranty_until?: string | null
}

export interface DeviceDetailResponse {
  device: Device
  metrics: DeviceMetric[]
  alerts: DeviceAlert[]
  tickets: DeviceTicket[]
  assignment: DeviceAssignment | null
  assignments: DeviceAssignment[]
  asset: DeviceAssetIdentity | null
}

export function listDevices(params: { q?: string; groupId?: string; status?: DeviceStatus; cursor?: string; limit?: number; offset?: number } = {}): Promise<{ devices: Device[]; total: number; nextCursor: string | null }> {
  const query = new URLSearchParams()
  if (params.q) query.set('q', params.q)
  if (params.groupId) query.set('groupId', params.groupId)
  if (params.status) query.set('status', params.status)
  if (params.limit !== undefined) query.set('limit', String(params.limit))
  if (params.offset !== undefined) query.set('offset', String(params.offset))
  if (params.cursor) query.set('cursor', params.cursor)
  const suffix = query.toString() ? `?${query.toString()}` : ''
  return api(`/devices${suffix}`)
}

export function getDevice(id: string): Promise<DeviceDetailResponse> {
  return api(`/devices/${id}`)
}

export function createDeviceAssignment(id: string, body: {
  userId?: string | null
  assignmentStatus: 'assigned' | 'shared' | 'temporary'
  department?: string
  teamId?: string | null
  location?: string
  expectedReturnAt?: string | null
  reason?: string
  notes?: string
}): Promise<{ assignment: DeviceAssignment }> {
  return api(`/devices/${id}/assignments`, { method: 'POST', body })
}

export function returnDeviceAssignment(id: string, assignmentId: string, notes?: string): Promise<{ assignment: DeviceAssignment }> {
  return api(`/devices/${id}/assignments/${assignmentId}/return`, { method: 'POST', body: { notes } })
}

export function listDeviceGroups(): Promise<{ groups: DeviceGroup[] }> {
  return api('/device-groups')
}

export function updateDevice(id: string, body: { name?: string; groupId?: string | null; deviceType?: DeviceType }): Promise<{ device: Device }> {
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
