import { useEffect, useMemo, useState } from 'react'
import { Alert, Field } from './ui.js'
import { Icon } from './Icons.js'
import '../styles/ai-settings.css'
import {
  getAiSettings,
  getAiUsage,
  testAiProvider,
  updateAiSettings,
  type AiProviderName,
  type AiSettingsView,
  type AiUsage,
} from '../lib/ai-settings.js'

const PROVIDERS: Array<{ value: AiProviderName; label: string; detail: string }> = [
  { value: 'openai_compatible', label: 'OpenAI-compatible', detail: 'OpenAI or another compatible hosted endpoint' },
  { value: 'azure_openai', label: 'Azure OpenAI', detail: 'Azure-hosted deployment; enter the resource URL and deployment name' },
  { value: 'ollama', label: 'Ollama', detail: 'Customer-managed local model server' },
  { value: 'vllm', label: 'vLLM', detail: 'Customer-managed OpenAI-compatible server' },
]

function limitLabel(value: number): string {
  return value < 0 ? 'Unlimited' : value.toLocaleString()
}

function UsageMeter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const percent = limit < 0 ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100))
  return <div className="ai-usage-meter"><div className="ai-usage-meter-head"><span>{label}</span><strong>{used.toLocaleString()} <small>/ {limitLabel(limit)}</small></strong></div><div className="ai-usage-track"><span style={{ width: `${limit < 0 ? 4 : percent}%` }} /></div></div>
}

export default function AiSettingsPanel() {
  const [settings, setSettings] = useState<AiSettingsView | null>(null)
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [draft, setDraft] = useState({
    enabled: true,
    providerMode: 'managed' as 'managed' | 'byok',
    provider: 'openai_compatible' as AiProviderName,
    baseUrl: '',
    model: '',
    allowlist: '',
    requestLimit: '',
    tokenLimit: '',
    retentionDays: 30,
    redactContent: true,
  })

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [result, usageResult] = await Promise.all([getAiSettings(), getAiUsage(30)])
      setSettings(result.settings)
      setUsage(usageResult.usage)
      setDraft({
        enabled: result.settings.enabled,
        providerMode: result.settings.providerMode,
        provider: result.settings.provider,
        baseUrl: result.settings.baseUrl,
        model: result.settings.model,
        allowlist: result.settings.modelAllowlist.join(', '),
        requestLimit: result.settings.monthlyRequestLimit < 0 ? '-1' : String(result.settings.monthlyRequestLimit),
        tokenLimit: result.settings.monthlyTokenLimit < 0 ? '-1' : String(result.settings.monthlyTokenLimit),
        retentionDays: result.settings.retentionDays,
        redactContent: result.settings.redactContent,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load AI settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  const provider = useMemo(() => PROVIDERS.find((item) => item.value === draft.provider) ?? PROVIDERS[0], [draft.provider])
  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const parseLimit = (value: string) => value.trim() === '' ? null : Number(value)
      const result = await updateAiSettings({
        enabled: draft.enabled,
        providerMode: draft.providerMode,
        provider: draft.provider,
        baseUrl: draft.providerMode === 'byok' ? draft.baseUrl.trim() : undefined,
        model: draft.providerMode === 'byok' ? draft.model.trim() : undefined,
        modelAllowlist: draft.allowlist.split(',').map((item) => item.trim()).filter(Boolean),
        apiKey: apiKey.trim() || undefined,
        clearApiKey: clearKey,
        retentionDays: draft.retentionDays,
        redactContent: draft.redactContent,
        monthlyRequestLimit: parseLimit(draft.requestLimit),
        monthlyTokenLimit: parseLimit(draft.tokenLimit),
      })
      setSettings(result.settings)
      setApiKey('')
      setClearKey(false)
      setMessage('AI governance settings saved.')
      const usageResult = await getAiUsage(30)
      setUsage(usageResult.usage)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save AI settings')
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError(null)
    setMessage(null)
    try {
      const result = await testAiProvider()
      if (!result.ok) throw new Error(result.error ?? 'Provider connection failed')
      setMessage('Provider connection succeeded.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Provider connection failed')
    } finally {
      setTesting(false)
    }
  }

  if (loading || !settings) return <div className="settings-card"><span className="etch">Loading AI governance…</span></div>

  return <section className="settings-card ai-settings-panel">
    <div className="settings-card-head"><div><h2>AI governance</h2><p>Control how ReyDesk uses AI for this organization. Provider credentials stay server-side and are never returned to the browser.</p></div><span className={`ai-status-badge ${settings.enabled && !settings.disabledReason ? 'is-ready' : 'is-disabled'}`}><span />{settings.enabled && !settings.disabledReason ? 'Available' : 'Not available'}</span></div>
    {error ? <Alert kind="error">{error}</Alert> : null}
    {message ? <Alert kind="info">{message}</Alert> : null}
    <div className="ai-governance-grid">
      <div className="ai-governance-main">
        <form onSubmit={(event) => void save(event)}>
          <div className="ai-settings-section"><div className="ai-settings-section-head"><Icon name="shield" size={16} /><div><strong>Organization policy</strong><span>Enable AI only when your plan and provider policy allow it.</span></div></div><button type="button" className={`settings-switch${draft.enabled ? ' on' : ''}`} aria-pressed={draft.enabled} onClick={() => setDraft((current) => ({ ...current, enabled: !current.enabled }))}><span /></button></div>
          <div className="settings-form-grid">
            <Field label="Provider ownership" hint="Managed keeps billing and operations with ReyDesk. BYOK is for enterprise deployments."><select className="field-input" value={draft.providerMode} onChange={(event) => setDraft((current) => ({ ...current, providerMode: event.target.value as 'managed' | 'byok' }))}><option value="managed">ReyDesk-managed provider</option><option value="byok">Bring your own provider</option></select></Field>
            <Field label="Provider"><select className="field-input" value={draft.provider} onChange={(event) => setDraft((current) => ({ ...current, provider: event.target.value as AiProviderName }))}>{PROVIDERS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
          </div>
          <p className="settings-note"><Icon name="alert" size={14} /> {provider.detail}. Self-hosted providers are supported as a controlled enterprise path; use HTTPS and private network routing in production.</p>
          {draft.providerMode === 'byok' ? <div className="settings-form-grid"><Field label="Provider base URL" hint="HTTPS is required in production unless private endpoints are explicitly enabled."><input className="field-input" type="url" value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.example.com/v1" required /></Field><Field label="Model"><input className="field-input" value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} placeholder="gpt-4o-mini" required /></Field><Field label="Provider API key" hint={settings.hasApiKey ? `Stored securely as ${settings.apiKeyMasked} (version ${settings.apiKeyVersion}). Enter a new key to rotate it.` : 'Encrypted before storage; never shown again.'}><input className="field-input" type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); setClearKey(false) }} placeholder={settings.hasApiKey ? 'Leave blank to keep current key' : 'Enter provider key'} autoComplete="new-password" />{settings.hasApiKey ? <label className="field-check"><input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} /> Remove stored key</label> : null}</Field><Field label="Model allowlist" hint="Comma-separated model IDs; leave blank to allow the selected model."><input className="field-input" value={draft.allowlist} onChange={(event) => setDraft((current) => ({ ...current, allowlist: event.target.value }))} placeholder="gpt-4o-mini, gpt-4.1-mini" /></Field></div> : <div className="ai-managed-note"><Icon name="key" size={16} /><div><strong>ReyDesk-managed provider key</strong><p>The deployment owns the provider credential. Add <code>REYDESK_AI_API_KEY</code> to the server secret manager; it is not stored in tenant settings or exposed to staff.</p></div></div>}
          <div className="ai-settings-section-head standalone"><Icon name="monitor" size={16} /><div><strong>Plan and organization limits</strong><span>Use -1 for unlimited. Organization limits cannot exceed your plan entitlement in production policy.</span></div></div>
          <div className="settings-form-grid"><Field label="Monthly AI requests"><input className="field-input" type="number" min={-1} value={draft.requestLimit} onChange={(event) => setDraft((current) => ({ ...current, requestLimit: event.target.value }))} placeholder={String(settings.entitlement.monthlyRequests)} /></Field><Field label="Monthly AI tokens"><input className="field-input" type="number" min={-1} value={draft.tokenLimit} onChange={(event) => setDraft((current) => ({ ...current, tokenLimit: event.target.value }))} placeholder={String(settings.entitlement.monthlyTokens)} /></Field><Field label="Usage retention (days)"><input className="field-input" type="number" min={7} max={3650} value={draft.retentionDays} onChange={(event) => setDraft((current) => ({ ...current, retentionDays: Number(event.target.value) }))} /></Field></div>
          <div className="ai-settings-section"><div className="ai-settings-section-head"><Icon name="shield" size={16} /><div><strong>Data handling</strong><span>Redact common secrets before provider calls and keep usage metadata for the configured retention window.</span></div></div><button type="button" className={`settings-switch${draft.redactContent ? ' on' : ''}`} aria-pressed={draft.redactContent} onClick={() => setDraft((current) => ({ ...current, redactContent: !current.redactContent }))}><span /></button></div>
          <div className="settings-form-actions"><button className="btn btn-primary" type="submit" disabled={busy}><Icon name="save" size={14} />{busy ? 'Saving…' : 'Save AI policy'}</button><button className="btn btn-ghost" type="button" onClick={() => void test()} disabled={testing || busy}><Icon name="refresh" size={14} />{testing ? 'Testing…' : 'Test provider connection'}</button></div>
        </form>
      </div>
      <aside className="ai-usage-card"><span className="settings-eyebrow">This month</span><h3>AI usage</h3><p>Plan: <strong>{settings.entitlement.plan}</strong></p><UsageMeter label="Requests" used={settings.requestsUsed} limit={settings.monthlyRequestLimit} /><UsageMeter label="Tokens" used={settings.tokensUsed} limit={settings.monthlyTokenLimit} />{usage ? <div className="ai-usage-summary"><span><strong>{usage.totalRequests.toLocaleString()}</strong> requests / 30 days</span><span><strong>{usage.totalTokens.toLocaleString()}</strong> tokens / 30 days</span><span><strong>{usage.byDay.reduce((sum, item) => sum + item.failures, 0)}</strong> provider failures</span></div> : null}<div className="ai-phase-list"><strong>Delivery path</strong><span className="is-now">Now · Managed provider, limits, usage, notice</span><span>Enterprise · BYOK, Azure, model allowlist</span><span>Self-hosted · Ollama/vLLM, private routing</span><span>Larger scale · customer-managed hosting and no-egress deployment (infrastructure phase)</span></div></aside>
    </div>
    <div className="ai-processing-notice"><Icon name="shield" size={15} /><p><strong>Data-processing notice</strong><br />{settings.processingNotice}</p></div>
  </section>
}
