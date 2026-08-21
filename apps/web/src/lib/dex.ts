import { api } from './api.js'

export interface DexComponents {
  performance: number
  availability: number
  security: number
  user_impact: number
  health?: number
  posture?: number
  online?: number
  application_reliability?: number
  network_quality?: number
  score_weights?: Record<string, number>
  signals?: Record<string, number | null>
}

export interface DexComparison {
  segment: string
  devices: number
  score: number
  performance: number
  availability: number
  security?: number
  user_impact: number
}

export interface DexTrend {
  day: string
  score: number
  performance: number
  availability: number
  security: number
  user_impact: number
  samples?: number
}

export interface DexRecommendation {
  code: string
  title: string
  detail: string
  priority: 'high' | 'medium' | 'low'
  deviceId?: string
  deviceName?: string
  userName?: string | null
}

export interface FleetDex {
  devices: number
  avg_score: number
  healthy: number
  poor: number
  performance_score: number
  availability_score: number
  security_score: number
  user_impact_score: number
  componentScores: { performance: number; availability: number; security: number; userImpact: number }
  openPostureAlerts: number
  postureCompliance: { totalDevices: number; compliantDevices: number; failingDevices: number; percentage: number }
  postureChecks: Array<{ check_path: string; open_count: number }>
  comparisons: DexComparison[]
  trends: DexTrend[]
  affected: Array<{ id: string; name: string; device_type: string; score: number; department: string | null; location: string | null; user_name: string | null; user_email: string | null }>
  recommendations: DexRecommendation[]
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
  score: { score: number; components: DexComponents; computed_at: string } | null
  history: Array<{ id: number; score: number; components: DexComponents; computed_at: string }>
  baseline?: { median: number | null; p90: number | null; samples: number }
  postureAlerts: PostureAlert[]
  recommendations?: DexRecommendation[]
}

export interface DexPolicy {
  id: string
  name: string
  device_type: string | null
  weights: Record<string, number>
  enabled: boolean
  created_at: string
  updated_at: string
}

export function fleetDex(): Promise<FleetDex> {
  return api('/dex/fleet')
}

export function getDeviceDex(id: string): Promise<DeviceDex> {
  return api(`/devices/${id}/dex`)
}

export function compareDex(dimension: 'department' | 'team' | 'location' | 'device_type'): Promise<{ dimension: string; comparisons: DexComparison[] }> {
  return api(`/dex/compare?dimension=${encodeURIComponent(dimension)}`)
}

export function dexTrends(days = 90): Promise<{ days: number; trends: DexTrend[] }> {
  return api(`/dex/trends?days=${days}`)
}

export function listDexPolicies(): Promise<{ policies: DexPolicy[] }> {
  return api('/dex/policies')
}

export function createDexPolicy(body: { name: string; deviceType?: string | null; weights: Record<string, number>; enabled?: boolean }): Promise<{ policy: DexPolicy }> {
  return api('/dex/policies', { method: 'POST', body })
}

export function submitDexSurvey(deviceId: string, body: { rating: number; comment?: string }): Promise<{ ok: true }> {
  return api(`/devices/${deviceId}/dex/survey`, { method: 'POST', body })
}
