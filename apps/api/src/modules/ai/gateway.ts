import { AppError } from '../../core/errors.js'
import type { AiConfig } from '../../config.js'

/**
 * Provider-agnostic AI gateway. The only operation the assistant needs today
 * is single-prompt text generation; the transport (OpenAI-compatible HTTP) is
 * isolated here so a local/self-hosted endpoint can be swapped in later and so
 * tests can drive the routes with a mock.
 */
export interface AiGenerateOptions {
  maxTokens?: number
  /** Used for tenant usage accounting; never sent to the provider. */
  operation?: string
}


export interface AiProvider {
  /** Generate text from one user prompt. Throws an AppError on failure. */
  generate(prompt: string, opts?: AiGenerateOptions): Promise<string>
}

const disabledProvider: AiProvider = {
  async generate() {
    throw new AppError(
      503,
      'ai_disabled',
      'AI assistant is not configured (set REYDESK_AI_ENABLED=true and REYDESK_AI_BASE_URL; legacy DESKOS_AI_* aliases are accepted during migration)',
    )
  },
}

/** Build the production provider from config; returns a 503 provider when disabled. */
export function createAiProvider(config: AiConfig): AiProvider {
  if (!config.enabled) return disabledProvider
  return new OpenAiCompatibleProvider(config)
}

class OpenAiCompatibleProvider implements AiProvider {
  constructor(private readonly config: AiConfig) {}

  async generate(prompt: string, opts?: AiGenerateOptions): Promise<string> {
    const base = this.config.baseUrl.replace(/\/+$/, '')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    try {
      const provider = this.config.provider ?? 'openai_compatible'
      const isAzure = provider === 'azure_openai'
      const endpoint = isAzure
        ? `${base}/openai/deployments/${encodeURIComponent(this.config.model)}/chat/completions?api-version=${encodeURIComponent(this.config.azureApiVersion ?? '2024-10-21')}`
        : `${base}/chat/completions`
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.config.apiKey ? (isAzure ? { 'api-key': this.config.apiKey } : { authorization: `Bearer ${this.config.apiKey}` }) : {}),
        },
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts?.maxTokens ?? 800,
          temperature: 0.2,
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new AppError(
          502,
          'ai_provider_error',
          `AI provider rejected the request (${res.status}): ${text.slice(0, 300)}`,
        )
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>
        content?: string
      }
      const content = (json.choices?.[0]?.message?.content ?? json.content ?? '').trim()
      if (!content) throw new AppError(502, 'ai_provider_error', 'AI provider returned an empty response')
      return content
    } catch (err) {
      if (err instanceof AppError) throw err
      if (err instanceof Error && err.name === 'AbortError') {
        throw new AppError(502, 'ai_timeout', 'AI provider did not respond in time')
      }
      throw new AppError(502, 'ai_provider_error', err instanceof Error ? err.message : 'AI provider request failed')
    } finally {
      clearTimeout(timer)
    }
  }
}
