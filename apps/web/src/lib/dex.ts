import { api } from './api.js'

export interface FleetDex {
  devices: number
  avg_score: number
  healthy: number
  poor: number
  openPostureAlerts: number
}

export interface PostureAlert {
  id: string
  policy_id: string | null
  check_path: string
  expected: unknown
  actual: unknown
  created_at: string
}

export interface DeviceDex {
  score: { score: number; components: Record<string, number>; computed_at: string } | null
  postureAlerts: PostureAlert[]
}

export function fleetDex(): Promise<FleetDex> {
  return api('/dex/fleet')
}

export function getDeviceDex(id: string): Promise<DeviceDex> {
  return api(`/devices/${id}/dex`)
}
