import { decryptSecret, encryptSecret, isEncryptedSecret, maskSecret } from '../../core/crypto.js'
import { AppError } from '../../core/errors.js'
import type { AppConfig } from '../../config.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { createAiProvider, type AiProvider, type AiGenerateOptions } from './gateway.js'

export type AiProviderMode = 'managed' | 'byok'
export type AiProviderName = 'openai_compatible' | 'azure_openai' | 'ollama' | 'vllm'

export interface AiEntitlement {
  plan: string
  enabled: boolean
  monthlyRequests: number
  monthlyTokens: number
  source: 'subscription' | 'trial'
}

export interface TenantAiRuntime {
  enabled: boolean
  mode: AiProviderMode
  provider: AiProviderName
  baseUrl: string
  apiKey: string
  model: string
  modelAllowlist: string[]
  retentionDays: number
  redactContent: boolean
  entitlement: AiEntitlement
  requestsUsed: number
  tokensUsed: number
  monthlyRequestLimit: number
  monthlyTokenLimit: number
  disabledReason?: string
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

const PROCESSING_NOTICE = 'AI may process ticket text and selected operational context to generate a response. ReyDesk redacts common secrets before sending content to a provider, never sends provider credentials to the browser, and keeps AI usage records without storing prompts or completions.'

const TRIAL_ENTITLEMENT: AiEntitlement = {
  plan: 'trial', enabled: true, monthlyRequests: 1000, monthlyTokens: 100000, source: 'trial',
}

function firstOfCurrentMonth(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10)
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4))
}

function parseList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 20)
}

function validateEndpoint(raw: string, production: boolean): string {
  let url: URL
  try { url = new URL(raw) } catch { throw AppError.badRequest('Enter a valid AI provider URL.', 'ai_invalid_base_url') }
  if (!['http:', 'https:'].includes(url.protocol)) throw AppError.badRequest('AI provider URL must use HTTP or HTTPS.', 'ai_invalid_base_url')
  if (production && url.protocol !== 'https:' && (process.env.REYDESK_AI_ALLOW_PRIVATE_ENDPOINTS ?? process.env.DESKOS_AI_ALLOW_PRIVATE_ENDPOINTS) !== 'true') {
    throw AppError.badRequest('Production AI endpoints must use HTTPS unless private endpoint access is explicitly enabled.', 'ai_invalid_base_url')
  }
  const privateHost = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)$/i.test(url.hostname)
    || /^10\./.test(url.hostname)
    || /^192\.168\./.test(url.hostname)
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(url.hostname)
  if (production && privateHost && (process.env.REYDESK_AI_ALLOW_PRIVATE_ENDPOINTS ?? process.env.DESKOS_AI_ALLOW_PRIVATE_ENDPOINTS) !== 'true') {
    throw AppError.badRequest('Private AI endpoints are disabled for this deployment.', 'ai_private_endpoint_disabled')
  }
  return url.toString().replace(/\/$/, '')
}

interface AiRuntimeRow {
  enabled?: boolean | null
  provider_mode?: string | null
  provider?: string | null
  base_url?: string | null
  model?: string | null
  api_key_enc?: string | null
  model_allowlist?: string | null
  monthly_request_limit?: number | null
  monthly_token_limit?: number | null
  api_key_version?: number | null
  api_key_rotated_at?: string | Date | null
  retention_days?: number | null
  redact_content?: boolean | null
  last_tested_at?: string | Date | null
  last_test_ok?: boolean | null
  last_test_error?: string | null
  plan_slug?: string | null
  ai_enabled?: boolean | null
  ai_monthly_requests?: number | null
  ai_monthly_tokens?: number | null
  requests_used?: number
  tokens_used?: number
}

function entitlementFor(row: AiRuntimeRow): AiEntitlement {
  if (!row.plan_slug) return TRIAL_ENTITLEMENT
  return {
    plan: String(row.plan_slug),
    enabled: Boolean(row.ai_enabled),
    monthlyRequests: Number(row.ai_monthly_requests ?? 0),
    monthlyTokens: Number(row.ai_monthly_tokens ?? 0),
    source: 'subscription',
  }
}

async function loadRuntimeRow(pool: DbPool, tenantId: string): Promise<AiRuntimeRow> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query(
      `SELECT s.enabled, s.provider_mode, s.provider, s.base_url, s.model, s.api_key_enc,
              s.model_allowlist, s.monthly_request_limit, s.monthly_token_limit,
              s.api_key_version, s.api_key_rotated_at, s.retention_days, s.redact_content, s.last_tested_at, s.last_test_ok,
              s.last_test_error, p.slug AS plan_slug, p.ai_enabled, p.ai_monthly_requests,
              p.ai_monthly_tokens
         FROM tenants t
         LEFT JOIN tenant_ai_settings s ON s.tenant_id = t.id
         LEFT JOIN tenant_subscriptions ts ON ts.tenant_id = t.id AND ts.status IN ('active', 'trialing')
         LEFT JOIN subscription_plans p ON p.id = ts.plan_id
        WHERE t.id = $1
        ORDER BY ts.created_at DESC NULLS LAST
        LIMIT 1`,
      [tenantId],
    )
    if (!result.rows[0]) throw AppError.notFound('Organization not found')
    const usage = await client.query(
      `SELECT request_count, token_count FROM ai_usage_periods WHERE tenant_id = $1 AND period_start = $2`,
      [tenantId, firstOfCurrentMonth()],
    )
    return { ...result.rows[0], requests_used: Number(usage.rows[0]?.request_count ?? 0), tokens_used: Number(usage.rows[0]?.token_count ?? 0) }
  })
}

export async function getTenantAiRuntime(
  pool: DbPool,
  config: AppConfig,
  tenantId: string,
  allowInjectedProvider = false,
): Promise<TenantAiRuntime> {
  const row = await loadRuntimeRow(pool, tenantId)
  const entitlement = entitlementFor(row)
  const mode: AiProviderMode = row.provider_mode === 'byok' ? 'byok' : 'managed'
  const rawProvider = row.provider ?? ''
  const provider: AiProviderName = ['openai_compatible', 'azure_openai', 'ollama', 'vllm'].includes(rawProvider) ? rawProvider as AiProviderName : 'openai_compatible'
  const apiKey = mode === 'byok' && typeof row.api_key_enc === 'string' && isEncryptedSecret(row.api_key_enc)
    ? decryptSecret(row.api_key_enc, config.emailKey)
    : mode === 'managed' ? config.ai.apiKey : ''
  const baseUrl = mode === 'byok' && row.base_url ? String(row.base_url) : config.ai.baseUrl
  const model = mode === 'byok' && row.model ? String(row.model) : config.ai.model
  const modelAllowlist = parseList(row.model_allowlist)
  const requestLimit = row.monthly_request_limit == null ? entitlement.monthlyRequests : Math.max(-1, Number(row.monthly_request_limit))
  const tokenLimit = row.monthly_token_limit == null ? entitlement.monthlyTokens : Math.max(-1, Number(row.monthly_token_limit))
  const enabledByProvider = mode === 'byok' ? Boolean(row.api_key_enc || ['ollama', 'vllm'].includes(provider)) : (config.ai.enabled || allowInjectedProvider)
  let disabledReason: string | undefined
  if (!entitlement.enabled && !allowInjectedProvider && entitlement.source === 'subscription') disabledReason = `AI is not included in the ${entitlement.plan} plan.`
  else if (row.enabled === false) disabledReason = 'AI has been disabled for this organization.'
  else if (!enabledByProvider) disabledReason = mode === 'byok' ? 'Add an enterprise provider credential before enabling AI.' : 'ReyDesk AI is not configured for this deployment.'
  else if (requestLimit === 0 || tokenLimit === 0) disabledReason = 'This organization has no AI usage allowance.'
  else if (modelAllowlist.length > 0 && !modelAllowlist.includes(model)) disabledReason = 'The selected model is not in the organization allowlist.'
  if (mode === 'byok') validateEndpoint(baseUrl, config.env === 'production')
  return {
    enabled: !disabledReason,
    mode, provider, baseUrl, apiKey, model, modelAllowlist,
    retentionDays: Math.max(7, Math.min(3650, Number(row.retention_days ?? 30))),
    redactContent: row.redact_content !== false,
    entitlement,
    requestsUsed: Number(row.requests_used ?? 0),
    tokensUsed: Number(row.tokens_used ?? 0),
    monthlyRequestLimit: requestLimit,
    monthlyTokenLimit: tokenLimit,
    ...(disabledReason ? { disabledReason } : {}),
  }
}

export async function getAiSettingsView(pool: DbPool, config: AppConfig, tenantId: string, allowInjectedProvider = false): Promise<AiSettingsView> {
  const [row, runtime] = await Promise.all([loadRuntimeRow(pool, tenantId), getTenantAiRuntime(pool, config, tenantId, allowInjectedProvider)])
  return {
    enabled: row.enabled !== false,
    providerMode: runtime.mode,
    provider: runtime.provider,
    baseUrl: runtime.mode === 'byok' ? runtime.baseUrl : '',
    model: runtime.mode === 'byok' ? runtime.model : '',
    modelAllowlist: runtime.modelAllowlist,
    hasApiKey: runtime.mode === 'byok' && typeof row.api_key_enc === 'string' && isEncryptedSecret(row.api_key_enc),
    apiKeyMasked: runtime.mode === 'byok' && row.api_key_enc ? maskSecret() : '',
    apiKeyVersion: Number(row.api_key_version ?? 1),
    apiKeyRotatedAt: row.api_key_rotated_at ? new Date(row.api_key_rotated_at).toISOString() : null,
    retentionDays: runtime.retentionDays,
    redactContent: runtime.redactContent,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at).toISOString() : null,
    lastTestOk: row.last_test_ok == null ? null : Boolean(row.last_test_ok),
    lastTestError: row.last_test_error ?? null,
    entitlement: runtime.entitlement,
    requestsUsed: runtime.requestsUsed,
    tokensUsed: runtime.tokensUsed,
    monthlyRequestLimit: runtime.monthlyRequestLimit,
    monthlyTokenLimit: runtime.monthlyTokenLimit,
    periodStart: firstOfCurrentMonth(),
    processingNotice: PROCESSING_NOTICE,
    ...(runtime.disabledReason ? { disabledReason: runtime.disabledReason } : {}),
  }
}

export async function updateAiSettings(pool: DbPool, config: AppConfig, tenantId: string, actorId: string, patch: AiSettingsPatch): Promise<void> {
  const current = await loadRuntimeRow(pool, tenantId)
  const mode = patch.providerMode ?? (current.provider_mode === 'byok' ? 'byok' : 'managed')
  const provider = patch.provider ?? (current.provider ?? 'openai_compatible')
  const baseUrl = patch.baseUrl !== undefined ? validateEndpoint(patch.baseUrl, config.env === 'production') : (current.base_url ?? null)
  const model = patch.model !== undefined ? patch.model.trim().slice(0, 160) : (current.model ?? null)
  const planEntitlement = entitlementFor(current)
  const requestedRequestLimit = patch.monthlyRequestLimit === null ? null : patch.monthlyRequestLimit === undefined ? (current.monthly_request_limit ?? null) : Math.max(-1, Math.min(10_000_000, Math.trunc(patch.monthlyRequestLimit)))
  const requestedTokenLimit = patch.monthlyTokenLimit === null ? null : patch.monthlyTokenLimit === undefined ? (current.monthly_token_limit ?? null) : Math.max(-1, Math.min(1_000_000_000, Math.trunc(patch.monthlyTokenLimit)))
  if (requestedRequestLimit !== null && planEntitlement.monthlyRequests >= 0 && (requestedRequestLimit < 0 || requestedRequestLimit > planEntitlement.monthlyRequests)) throw AppError.badRequest(`Monthly AI requests cannot exceed the ${planEntitlement.plan} plan allowance.`, 'ai_plan_limit')
  if (requestedTokenLimit !== null && planEntitlement.monthlyTokens >= 0 && (requestedTokenLimit < 0 || requestedTokenLimit > planEntitlement.monthlyTokens)) throw AppError.badRequest(`Monthly AI tokens cannot exceed the ${planEntitlement.plan} plan allowance.`, 'ai_plan_limit')
  const monthlyRequestLimit = requestedRequestLimit
  const monthlyTokenLimit = requestedTokenLimit
  if (mode === 'byok' && !baseUrl) throw AppError.badRequest('A provider URL is required for BYOK.', 'ai_invalid_base_url')
  if (mode === 'byok' && !model) throw AppError.badRequest('A model is required for BYOK.', 'ai_invalid_model')
  const allowlist = patch.modelAllowlist ?? parseList(current.model_allowlist)
  const rotatesCredential = Boolean(patch.apiKey?.trim() || patch.clearApiKey)
  const secret = patch.apiKey?.trim() ? encryptSecret(patch.apiKey.trim(), config.emailKey) : patch.clearApiKey ? null : (current.api_key_enc ?? null)
  const apiKeyVersion = Number(current.api_key_version ?? 1) + (rotatesCredential ? 1 : 0)
  const apiKeyRotatedAt = rotatesCredential ? new Date() : (current.api_key_rotated_at ?? null)
  if (mode === 'byok' && !secret && !['ollama', 'vllm'].includes(provider)) throw AppError.badRequest('Add a provider credential before enabling BYOK.', 'ai_credential_required')
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO tenant_ai_settings
         (tenant_id, enabled, provider_mode, provider, base_url, model, api_key_enc, model_allowlist, monthly_request_limit, monthly_token_limit, api_key_version, api_key_rotated_at, retention_days, redact_content, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled = EXCLUDED.enabled, provider_mode = EXCLUDED.provider_mode, provider = EXCLUDED.provider,
         base_url = EXCLUDED.base_url, model = EXCLUDED.model, api_key_enc = EXCLUDED.api_key_enc,
         model_allowlist = EXCLUDED.model_allowlist, monthly_request_limit = EXCLUDED.monthly_request_limit,
         monthly_token_limit = EXCLUDED.monthly_token_limit, api_key_version = EXCLUDED.api_key_version,
         api_key_rotated_at = EXCLUDED.api_key_rotated_at, retention_days = EXCLUDED.retention_days,
         redact_content = EXCLUDED.redact_content, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, patch.enabled ?? current.enabled ?? true, mode, provider, baseUrl, model, secret, JSON.stringify(allowlist), monthlyRequestLimit, monthlyTokenLimit, apiKeyVersion, apiKeyRotatedAt, Math.max(7, Math.min(3650, patch.retentionDays ?? Number(current.retention_days ?? 30))), patch.redactContent ?? current.redact_content !== false, actorId],
    )
  })
}

export async function testTenantAiProvider(pool: DbPool, config: AppConfig, tenantId: string, injectedProvider?: AiProvider): Promise<{ ok: boolean; error?: string }> {
  try {
    const runtime = await getTenantAiRuntime(pool, config, tenantId, Boolean(injectedProvider))
    if (!runtime.enabled && !injectedProvider) throw new AppError(400, 'ai_not_ready', runtime.disabledReason ?? 'AI is not ready')
    const provider = injectedProvider ?? createAiProvider({ ...config.ai, enabled: true, provider: runtime.provider, baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, model: runtime.model })
    await provider.generate('Return exactly the word READY. Do not include any other text.', { maxTokens: 8, operation: 'connection_test' })
    await withTenant(pool, tenantId, async (client) => {
      await client.query('UPDATE tenant_ai_settings SET last_tested_at = now(), last_test_ok = true, last_test_error = NULL, updated_at = now() WHERE tenant_id = $1', [tenantId])
    })
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : 'Provider connection failed'
    await withTenant(pool, tenantId, async (client) => {
      await client.query('UPDATE tenant_ai_settings SET last_tested_at = now(), last_test_ok = false, last_test_error = $2, updated_at = now() WHERE tenant_id = $1', [tenantId, message])
    }).catch(() => undefined)
    return { ok: false, error: message }
  }
}

export async function getAiUsage(pool: DbPool, tenantId: string, days = 30): Promise<{ totalRequests: number; totalTokens: number; byDay: Array<{ day: string; requests: number; tokens: number; failures: number }> }> {
  return withTenant(pool, tenantId, async (client) => {
    const totals = await client.query(
      `SELECT count(*)::int AS requests, COALESCE(sum(input_tokens + output_tokens), 0)::int AS tokens,
              count(*) FILTER (WHERE success = false)::int AS failures
         FROM ai_usage_events WHERE created_at >= now() - ($1::int * interval '1 day')`,
      [days],
    )
    const daily = await client.query(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
              count(*)::int AS requests,
              COALESCE(sum(input_tokens + output_tokens), 0)::int AS tokens,
              count(*) FILTER (WHERE success = false)::int AS failures
         FROM ai_usage_events
        WHERE created_at >= now() - ($1::int * interval '1 day')
        GROUP BY 1 ORDER BY 1 DESC`,
      [days],
    )
    return {
      totalRequests: Number(totals.rows[0]?.requests ?? 0),
      totalTokens: Number(totals.rows[0]?.tokens ?? 0),
      byDay: daily.rows.map((row) => ({ day: row.day, requests: Number(row.requests), tokens: Number(row.tokens), failures: Number(row.failures) })),
    }
  })
}

async function adjustPeriod(pool: DbPool, tenantId: string, requestDelta: number, tokenDelta: number): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ai_usage_periods (tenant_id, period_start, request_count, token_count)
       VALUES ($1, $2, $3, GREATEST(0, $4))
       ON CONFLICT (tenant_id, period_start) DO UPDATE SET
         request_count = GREATEST(0, ai_usage_periods.request_count + $3),
         token_count = GREATEST(0, ai_usage_periods.token_count + $4), updated_at = now()`,
      [tenantId, firstOfCurrentMonth(), requestDelta, tokenDelta],
    )
  })
}

async function reservePeriod(pool: DbPool, runtime: TenantAiRuntime, tenantId: string, reservedTokens: number): Promise<void> {
  if (runtime.monthlyRequestLimit < 0 && runtime.monthlyTokenLimit < 0) return
  const requestLimit = runtime.monthlyRequestLimit
  const tokenLimit = runtime.monthlyTokenLimit
  const result = await withTenant(pool, tenantId, async (client) => {
    await client.query(
      `INSERT INTO ai_usage_periods (tenant_id, period_start) VALUES ($1, $2)
       ON CONFLICT (tenant_id, period_start) DO NOTHING`,
      [tenantId, firstOfCurrentMonth()],
    )
    return client.query(
      `UPDATE ai_usage_periods
          SET request_count = request_count + 1, token_count = token_count + $3, updated_at = now()
        WHERE tenant_id = $1 AND period_start = $2
          AND ($4 < 0 OR request_count < $4)
          AND ($5 < 0 OR token_count + $3 <= $5)
        RETURNING request_count`,
      [tenantId, firstOfCurrentMonth(), reservedTokens, requestLimit, tokenLimit],
    )
  })
  if (!result.rows[0]) throw new AppError(429, 'ai_usage_limit', 'This organization has reached its AI usage allowance for the current month.')
}

export function redactAiContent(input: string): string {
  return input
    .replace(/(password|passwd|secret|api[_ -]?key|token|recovery code)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]')
    .replace(/\b\d{6,8}\b/g, '[REDACTED_CODE]')
}

class MeteredAiProvider implements AiProvider {
  constructor(private readonly pool: DbPool, private readonly tenantId: string, private readonly runtime: TenantAiRuntime, private readonly inner: AiProvider) {}

  async generate(prompt: string, opts?: AiGenerateOptions): Promise<string> {
    const safePrompt = this.runtime.redactContent ? redactAiContent(prompt) : prompt
    const maxTokens = Math.max(1, opts?.maxTokens ?? 800)
    const reservedTokens = estimateTokens(safePrompt) + maxTokens
    await reservePeriod(this.pool, this.runtime, this.tenantId, reservedTokens)
    try {
      const content = await this.inner.generate(safePrompt, opts)
      const inputTokens = estimateTokens(safePrompt)
      const outputTokens = estimateTokens(content)
      await adjustPeriod(this.pool, this.tenantId, 0, outputTokens - maxTokens)
      await withTenant(this.pool, this.tenantId, async (client) => {
        await client.query(
          `INSERT INTO ai_usage_events (tenant_id, user_id, operation, provider, model, input_tokens, output_tokens, success)
           VALUES ($1, NULL, $2, $3, $4, $5, $6, true)`,
          [this.tenantId, opts?.operation ?? 'unknown', this.runtime.provider, this.runtime.model, inputTokens, outputTokens],
        )
      })
      return content
    } catch (error) {
      await adjustPeriod(this.pool, this.tenantId, -1, -reservedTokens)
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : 'provider_error'
      await withTenant(this.pool, this.tenantId, async (client) => {
        await client.query(
          `INSERT INTO ai_usage_events (tenant_id, user_id, operation, provider, model, input_tokens, output_tokens, success, error_code)
           VALUES ($1, NULL, $2, $3, $4, $5, 0, false, $6)`,
          [this.tenantId, opts?.operation ?? 'unknown', this.runtime.provider, this.runtime.model, estimateTokens(safePrompt), code],
        )
      }).catch(() => undefined)
      throw error
    }
  }
}

export async function createTenantAiProvider(pool: DbPool, config: AppConfig, tenantId: string, injectedProvider?: AiProvider, allowInjectedProvider = false): Promise<{ runtime: TenantAiRuntime; provider: AiProvider; model: string }> {
  const runtime = await getTenantAiRuntime(pool, config, tenantId, Boolean(injectedProvider) && allowInjectedProvider)
  if (!runtime.enabled && !(injectedProvider && allowInjectedProvider)) {
    // Keep deployment misconfiguration distinguishable from a tenant policy
    // denial. The former is surfaced as the gateway's 503 ai_disabled response;
    // the latter remains a deliberate 403 governance decision.
    if (runtime.disabledReason === 'ReyDesk AI is not configured for this deployment.') {
      return { runtime, provider: createAiProvider(config.ai), model: runtime.model }
    }
    throw new AppError(403, 'ai_unavailable', runtime.disabledReason ?? 'AI is not available')
  }
  const inner = injectedProvider ?? createAiProvider({ ...config.ai, enabled: true, provider: runtime.provider, baseUrl: runtime.baseUrl, apiKey: runtime.apiKey, model: runtime.model })
  return { runtime, provider: new MeteredAiProvider(pool, tenantId, runtime, inner), model: runtime.model }
}

export async function purgeExpiredAiUsage(pool: DbPool): Promise<number> {
  // Tenants without an override still receive the documented 30-day default.
  const result = await pool.query(`
    DELETE FROM ai_usage_events e
     WHERE e.created_at < now() - (
       COALESCE((SELECT s.retention_days FROM tenant_ai_settings s WHERE s.tenant_id = e.tenant_id), 30)::text || ' days'
     )::interval`)
  return result.rowCount ?? 0
}

export function aiProcessingNotice(): string {
  return PROCESSING_NOTICE
}
