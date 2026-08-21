import { api } from './api.js'

export type AiProviderMode = 'managed' | 'byok'
export type AiProviderName = 'openai_compatible' | 'azure_openai' | 'ollama' | 'vllm'

export interface AiEntitlement {
  plan: string
  enabled: boolean
  monthlyRequests: number
  monthlyTokens: number
  source: 'subscription' | 'trial'
}

export interface AiSettingsView {
  enabled: boolean
  providerMode: AiProviderMode
  provider: AiProviderName
  baseUrl: string
  model: string
  modelAllowlist: string[]
  hasApiKey: boolean
  apiKeyMasked: string
  apiKeyVersion: number
  apiKeyRotatedAt: string | null
  retentionDays: number
  redactContent: boolean
  lastTestedAt: string | null
  lastTestOk: boolean | null
  lastTestError: string | null
  entitlement: AiEntitlement
  requestsUsed: number
  tokensUsed: number
  monthlyRequestLimit: number
  monthlyTokenLimit: number
  periodStart: string
  processingNotice: string
  disabledReason?: string
}

export interface AiSettingsPatch {
  enabled?: boolean
  providerMode?: AiProviderMode
  provider?: AiProviderName
  baseUrl?: string
  model?: string
  modelAllowlist?: string[]
  apiKey?: string
  clearApiKey?: boolean
  retentionDays?: number
  redactContent?: boolean
  monthlyRequestLimit?: number | null
  monthlyTokenLimit?: number | null
}

export interface AiUsage {
  totalRequests: number
  totalTokens: number
  byDay: Array<{ day: string; requests: number; tokens: number; failures: number }>
}

export function getAiSettings(): Promise<{ settings: AiSettingsView; notice: string }> {
  return api('/ai/settings')
}

export function updateAiSettings(patch: AiSettingsPatch): Promise<{ settings: AiSettingsView }> {
  return api('/ai/settings', { method: 'PATCH', body: patch })
}

export function testAiProvider(): Promise<{ ok: boolean; error?: string }> {
  return api('/ai/settings/test', { method: 'POST', body: {} })
}

export function getAiUsage(days = 30): Promise<{ usage: AiUsage }> {
  return api(`/ai/usage?days=${days}`)
}
