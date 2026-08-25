import { useCallback, useEffect, useMemo, useState } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field } from '../components/ui.js'
import { Icon, type IconName } from '../components/Icons.js'
import { getTenant, updateTenant } from '../lib/tenant.js'
import { updateBranding } from '../lib/msp.js'
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes } from '../lib/idle.js'
import { api } from '../lib/api.js'
import { useTheme } from '../lib/theme.js'
import TicketSettingsPage from './TicketSettingsPage.js'
import EmailSettingsPage from './EmailSettingsPage.js'
import CannedResponsesPage from './CannedResponsesPage.js'
import NotificationSettingsPage from './NotificationSettingsPage.js'
import SecuritySettingsPage from './SecuritySettingsPage.js'
import EntraSettingsPage from './EntraSettingsPage.js'
import AdSettingsPage from './AdSettingsPage.js'
import PublicApiSettingsPage from './PublicApiSettingsPage.js'
import AiSettingsPanel from '../components/AiSettingsPanel.js'
import '../styles/settings.css'

interface WorkspaceSettings {
  ticket_prefix: string
  auto_assign_enabled: boolean
  auto_close_enabled: boolean
  auto_close_after_days: number
  require_description: boolean
  allow_attachments: boolean
  public_notes_visible: boolean
  default_priority: string
  default_type: string
  ai_triage: {
    enabled: boolean
    autoReply: boolean
    autoResolve: boolean
    maxRounds: number
    resolveConfidence: number
    sources: string[]
  }
  portal: {
    enabled: boolean
    allow_public_kb: boolean
    show_device_context: boolean
    allow_customer_resolution: boolean
    allow_registration: boolean
    registration_domains: string[]
    welcome_message: string
    slug: string
  }
  remote_support: {
    require_consent: boolean
    default_expiry_minutes: number
    allow_file_transfer: boolean
    allow_clipboard: boolean
    allow_terminal: boolean
    allow_system_manage: boolean
    default_recording_mode: 'off' | 'metadata' | 'video'
    recording_retention_days: number
  }
  endpoints: {
    offline_after_minutes: number
    heartbeat_interval_seconds: number
    allow_self_enrollment: boolean
    enrollment_code_expiry_minutes: number
  }
  monitoring: {
    create_tickets_by_default: boolean
    offline_ticket_mode: 'alert_only' | 'ticket'
    default_ticket_priority: string
    default_severity: 'info' | 'warning' | 'critical'
  }
  data_retention: {
    audit_days: number
    recording_days: number
    notification_days: number
  }
}

const DEFAULT_SETTINGS: WorkspaceSettings = {
  ticket_prefix: 'TKT', auto_assign_enabled: false, auto_close_enabled: false, auto_close_after_days: 7,
  require_description: true, allow_attachments: true, public_notes_visible: true,
  default_priority: 'p3', default_type: 'incident',
  ai_triage: { enabled: true, autoReply: true, autoResolve: true, maxRounds: 4, resolveConfidence: 0.92, sources: ['portal', 'email', 'phone'] },
  portal: { enabled: true, allow_public_kb: true, show_device_context: true, allow_customer_resolution: true, allow_registration: false, registration_domains: [], welcome_message: '', slug: '' },
  remote_support: { require_consent: true, default_expiry_minutes: 30, allow_file_transfer: true, allow_clipboard: true, allow_terminal: false, allow_system_manage: false, default_recording_mode: 'metadata', recording_retention_days: 30 },
  endpoints: { offline_after_minutes: 10, heartbeat_interval_seconds: 30, allow_self_enrollment: true, enrollment_code_expiry_minutes: 15 },
  monitoring: { create_tickets_by_default: true, offline_ticket_mode: 'alert_only', default_ticket_priority: 'p3', default_severity: 'warning' },
  data_retention: { audit_days: 365, recording_days: 30, notification_days: 90 },
}

/** Normalize legacy or partially populated tenant settings before rendering. */
function normalizeWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const source = raw && typeof raw === 'object' ? raw as Record<string, any> : {}
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    ai_triage: { ...DEFAULT_SETTINGS.ai_triage, ...(source.ai_triage ?? {}) },
    portal: { ...DEFAULT_SETTINGS.portal, ...(source.portal ?? {}) },
    remote_support: { ...DEFAULT_SETTINGS.remote_support, ...(source.remote_support ?? {}) },
    endpoints: { ...DEFAULT_SETTINGS.endpoints, ...(source.endpoints ?? {}) },
    monitoring: { ...DEFAULT_SETTINGS.monitoring, ...(source.monitoring ?? {}) },
    data_retention: { ...DEFAULT_SETTINGS.data_retention, ...(source.data_retention ?? {}) },
  }
}

type SettingsTab = 'home' | 'preferences' | 'tickets' | 'email' | 'canned' | 'notifications' | 'ai' | 'security' | 'active-directory' | 'ad' | 'branding' | 'portal' | 'remote' | 'devices' | 'monitoring' | 'data' | 'integrations' | 'api'

interface SettingLink {
  to: string
  tab: SettingsTab
  label: string
  description: string
  icon: IconName
}

const GROUPS: Array<{ label: string; links: SettingLink[] }> = [
  {
    label: 'Organization',
    links: [
      { to: '/settings', tab: 'home', label: 'Overview', description: 'Organization identity and configuration coverage', icon: 'settings' },
      { to: '/settings/branding', tab: 'branding', label: 'Branding & portal', description: 'Portal identity, logo, color, and customer experience', icon: 'monitor' },
    ],
  },
  {
    label: 'Workspace',
    links: [
      { to: '/settings/preferences', tab: 'preferences', label: 'My preferences', description: 'Screen lock, locale, and personal defaults', icon: 'user' },
      { to: '/settings/tickets', tab: 'tickets', label: 'Ticketing', description: 'Defaults, automations, SLAs, categories, and escalation', icon: 'ticket' },
      { to: '/settings/email', tab: 'email', label: 'Email channels', description: 'Inbound support mailboxes and polling', icon: 'mail' },
      { to: '/settings/canned', tab: 'canned', label: 'Canned responses', description: 'Reusable replies for the service desk', icon: 'file' },
      { to: '/settings/notifications', tab: 'notifications', label: 'Notifications', description: 'Push and event notification preferences', icon: 'alert' },
      { to: '/settings/ai', tab: 'ai', label: 'AI ticket triage', description: 'Bounded questions, resolution, and human handoff', icon: 'wrench' },
    ],
  },
  {
    label: 'Security & access',
    links: [
      { to: '/settings/security', tab: 'security', label: 'Authentication', description: 'MFA policy, passkeys, and user security actions', icon: 'shield' },
      { to: '/settings/active-directory', tab: 'active-directory', label: 'Directory sync', description: 'Microsoft Entra ID directory connections', icon: 'user' },
      { to: '/settings/ad', tab: 'ad', label: 'On-prem Active Directory', description: 'LDAP/LDAPS domain controller sync and actions', icon: 'server' },
      { to: '/settings/api', tab: 'api', label: 'Public API', description: 'OAuth clients, scopes, and developer documentation', icon: 'key' },
    ],
  },
  {
    label: 'Operations',
    links: [
      { to: '/settings/portal', tab: 'portal', label: 'Customer portal', description: 'Self-service access and requester experience', icon: 'external' },
      { to: '/settings/remote', tab: 'remote', label: 'Remote support', description: 'Consent, session permissions, recording, and expiry', icon: 'monitor' },
      { to: '/settings/devices', tab: 'devices', label: 'Devices & agents', description: 'Heartbeat, offline detection, and enrollment defaults', icon: 'monitor' },
      { to: '/settings/monitoring', tab: 'monitoring', label: 'Monitoring', description: 'Alert severity, ticket creation, and device thresholds', icon: 'alert' },
      { to: '/settings/integrations', tab: 'integrations', label: 'Integrations', description: 'Webhooks, marketplace apps, and connected services', icon: 'settings' },
      { to: '/settings/data', tab: 'data', label: 'Data retention', description: 'Audit, notification, and session recording retention', icon: 'clock' },
    ],
  },
]

function useWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [portalInfo, setPortalInfo] = useState<{ slug: string; url: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await api<{ settings: WorkspaceSettings; portal: { slug: string; url: string } }>('/tenant/settings')
      setSettings(normalizeWorkspaceSettings(response.settings))
      setPortalInfo(response.portal ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load workspace settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (patch: Partial<WorkspaceSettings>) => {
    setError(null)
    const response = await api<{ settings: WorkspaceSettings; portal: { slug: string; url: string } }>('/tenant/settings', { method: 'PATCH', body: patch })
    setSettings(normalizeWorkspaceSettings(response.settings))
    setPortalInfo(response.portal ?? null)
  }

  return { settings, portalInfo, loading, error, setError, save, reload: load }
}

function SettingsNavigation({ active }: { active: SettingsTab }) {
  return (
    <aside className="settings-navigation" aria-label="Settings navigation">
      {GROUPS.map((group) => (
        <div className="settings-navigation-group" key={group.label}>
          <div className="settings-navigation-label">{group.label}</div>
          {group.links.map((link) => (
            <NavLink key={link.to} to={link.to} className={`settings-navigation-link${active === link.tab ? ' active' : ''}`}>
              <Icon name={link.icon} size={16} />
              <span><strong>{link.label}</strong><small>{link.description}</small></span>
            </NavLink>
          ))}
        </div>
      ))}
    </aside>
  )
}

function SettingSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <section className="settings-card"><div className="settings-card-head"><div><h2>{title}</h2><p>{description}</p></div></div>{children}</section>
}

function ToggleRow({ label, description, checked, disabled, onChange }: { label: string; description: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <div className={`settings-toggle-row${disabled ? ' disabled' : ''}`}><span><strong>{label}</strong><small>{description}</small></span><button type="button" className={`settings-switch${checked ? ' on' : ''}`} aria-label={`${checked ? 'Disable' : 'Enable'} ${label}`} aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button></div>
}

function OrganizationSettings() {
  const [form, setForm] = useState<{ name: string; slug: string; region: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { getTenant().then((r) => setForm({ name: r.tenant.name, slug: r.tenant.slug, region: r.tenant.region })).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load organization')) }, [])
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!form) return; setBusy(true); setError(null)
    try { const r = await updateTenant(form); setForm({ name: r.tenant.name, slug: r.tenant.slug, region: r.tenant.region }); setMessage('Organization details saved.') } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') } finally { setBusy(false) }
  }
  if (!form) return <div className="settings-card"><span className="etch">Loading organization…</span></div>
  return <SettingSection title="Organization identity" description="The name, URL slug, and region shown throughout the workspace."><>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}<form onSubmit={save} className="settings-form-grid"><Field label="Organization name"><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></Field><Field label="Slug" hint="lowercase letters, numbers, and hyphens"><input className="field-input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required /></Field><Field label="Region"><input className="field-input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} required /></Field><div className="settings-form-actions"><button className="btn btn-primary" type="submit" disabled={busy}><Icon name="save" size={14} />{busy ? 'Saving…' : 'Save identity'}</button></div></form></></SettingSection>
}

function PreferencesSettings() {
  const [idleMinutes, setIdleMinutes] = useState(getIdleTimeoutMinutes())
  const [notice, setNotice] = useState<string | null>(null)
  const { theme, toggle } = useTheme()
  return <SettingSection title="My preferences" description="Personal settings that apply to your account across all organizations."><><Field label="Screen lock timeout" hint="Minutes of inactivity before the console locks (1–120, or 0 to disable)"><div className="settings-inline-field"><input className="field-input" type="number" min={0} max={120} value={idleMinutes} onChange={(e) => setIdleMinutes(Math.max(0, Math.min(120, Number(e.target.value))))} /><span className="muted">{idleMinutes === 0 ? 'Disabled' : `${idleMinutes} minute${idleMinutes === 1 ? '' : 's'}`}</span></div></Field><div className="settings-preference-row"><div><strong>Appearance</strong><small>Choose the console theme for this browser.</small></div><button className="btn btn-ghost btn-sm" type="button" onClick={toggle}><Icon name="settings" size={14} />Use {theme === 'dark' ? 'light' : 'dark'} mode</button></div><div className="settings-form-actions"><button className="btn btn-primary" onClick={() => { setIdleTimeoutMinutes(idleMinutes); setNotice('Preferences saved.') }}><Icon name="save" size={14} />Save preferences</button>{notice && <span className="settings-saved">{notice}</span>}</div></></SettingSection>
}

interface BrandingDraft {
  portalTitle: string
  logoUrl: string
  primaryColor: string
}

const DEFAULT_BRANDING: BrandingDraft = {
  portalTitle: '',
  logoUrl: '',
  primaryColor: '#e8a33d',
}

function brandingTextColor(hex: string): string {
  const value = hex.replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return '#1b1408'
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16))
  const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000
  return luminance > 155 ? '#1b1408' : '#ffffff'
}

function brandingFromTenant(settings: Record<string, unknown> | undefined): BrandingDraft {
  const branding = settings?.branding && typeof settings.branding === 'object' ? settings.branding as Record<string, unknown> : {}
  return {
    portalTitle: typeof branding.portalTitle === 'string' ? branding.portalTitle : DEFAULT_BRANDING.portalTitle,
    logoUrl: typeof branding.logoUrl === 'string' ? branding.logoUrl : DEFAULT_BRANDING.logoUrl,
    primaryColor: typeof branding.primaryColor === 'string' ? branding.primaryColor : DEFAULT_BRANDING.primaryColor,
  }
}

function BrandingSettings() {
  const [form, setForm] = useState<BrandingDraft>(DEFAULT_BRANDING)
  const [saved, setSaved] = useState<BrandingDraft>(DEFAULT_BRANDING)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [logoFailed, setLogoFailed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const dirty = JSON.stringify(form) !== JSON.stringify(saved)
  const validColor = /^#[0-9a-f]{6}$/i.test(form.primaryColor)
  const previewColor = validColor ? form.primaryColor : DEFAULT_BRANDING.primaryColor
  const previewTitle = form.portalTitle.trim() || 'Your support portal'
  const previewTextColor = brandingTextColor(previewColor)
  const previewInitial = previewTitle.slice(0, 1).toUpperCase()

  useEffect(() => {
    let active = true
    getTenant()
      .then((response) => {
        if (!active) return
        const branding = brandingFromTenant(response.tenant.settings)
        setForm(branding)
        setSaved(branding)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load branding')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!validColor) {
      setError('Enter a six-digit hexadecimal color, for example #e8a33d.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await updateBranding({
        portalTitle: form.portalTitle.trim() || null,
        logoUrl: form.logoUrl.trim() || null,
        primaryColor: form.primaryColor,
      })
      const next = {
        portalTitle: response.branding.portalTitle ?? '',
        logoUrl: response.branding.logoUrl ?? '',
        primaryColor: response.branding.primaryColor ?? DEFAULT_BRANDING.primaryColor,
      }
      setForm(next)
      setSaved(next)
      setLogoFailed(false)
      setMessage('Branding saved and applied to the customer portal.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save branding')
    } finally {
      setBusy(false)
    }
  }

  const resetDraft = () => {
    setForm(saved)
    setLogoFailed(false)
    setMessage(null)
    setError(null)
  }

  if (loading) return <div className="settings-card"><span className="etch">Loading branding…</span></div>

  return <SettingSection title="Branding & customer portal" description="Shape the identity customers see when they raise requests, follow tickets, and use your support portal.">
    <>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}
      <div className="branding-workspace">
        <form onSubmit={(event) => void save(event)} className="branding-editor">
          <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="settings" size={15} /></span><div><h3>Brand identity</h3><p>Use a name and logo your requesters will recognise.</p></div></div>
          <div className="branding-fields">
            <Field label="Portal name" hint="Shown in the portal header and browser context."><input className="field-input" value={form.portalTitle} onChange={(event) => setForm((current) => ({ ...current, portalTitle: event.target.value }))} placeholder="Your support portal" maxLength={60} /></Field>
            <Field label="Logo URL" hint="Use a public HTTPS image URL, ideally an SVG or square PNG."><div className="branding-logo-input"><input className="field-input" type="url" value={form.logoUrl} onChange={(event) => { setForm((current) => ({ ...current, logoUrl: event.target.value })); setLogoFailed(false) }} placeholder="https://example.com/logo.svg" maxLength={500} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => { setForm((current) => ({ ...current, logoUrl: '' })); setLogoFailed(false) }} disabled={!form.logoUrl} aria-label="Remove logo"><Icon name="delete" size={14} /></button></div></Field>
          </div>
          <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="eye" size={15} /></span><div><h3>Visual system</h3><p>Choose the accent used for portal actions and highlights.</p></div></div>
          <Field label="Portal accent" hint="Pick a brand color or enter its six-digit hexadecimal value."><div className="branding-color-control"><input className="settings-color-input" type="color" value={validColor ? form.primaryColor : DEFAULT_BRANDING.primaryColor} onChange={(event) => setForm((current) => ({ ...current, primaryColor: event.target.value }))} aria-label="Choose portal accent" /><input className="field-input mono" value={form.primaryColor} onChange={(event) => setForm((current) => ({ ...current, primaryColor: event.target.value }))} placeholder="#e8a33d" maxLength={7} aria-label="Portal accent hexadecimal value" /><span className="branding-color-swatch" style={{ backgroundColor: previewColor }} aria-label={`Preview color ${previewColor}`} /></div></Field>
          <div className="branding-where-used"><strong>Applied to</strong><span><Icon name="external" size={13} /> Customer portal header</span><span><Icon name="ticket" size={13} /> Requester ticket actions</span><span><Icon name="mail" size={13} /> Portal-facing email links</span></div>
          <div className="settings-form-actions"><button className="btn btn-primary" type="submit" disabled={busy || !dirty}><Icon name="save" size={14} />{busy ? 'Saving…' : 'Save branding'}</button>{dirty ? <button className="btn btn-ghost" type="button" onClick={resetDraft}>Discard changes</button> : <span className="settings-saved"><Icon name="check" size={13} />All changes saved</span>}<a className="btn btn-ghost" href="/portal" target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open portal</a></div>
        </form>
        <aside className="branding-preview" aria-label="Customer portal preview">
          <div className="branding-preview-head"><div><span className="settings-eyebrow">Live preview</span><strong>Customer portal</strong></div><span className="branding-preview-status"><span />Preview</span></div>
          <div className="branding-preview-window">
            <div className="branding-preview-nav"><div className="branding-preview-brand">{form.logoUrl && !logoFailed ? <img src={form.logoUrl} alt="" onError={() => setLogoFailed(true)} /> : <span className="branding-preview-mark" style={{ backgroundColor: previewColor, color: previewTextColor }}>{previewInitial}</span>}<strong>{previewTitle}</strong></div><span className="branding-preview-avatar">JD</span></div>
            <div className="branding-preview-body"><span className="branding-preview-kicker">SUPPORT CENTRE</span><h4>How can we help?</h4><p>Find an answer or send a request to your support team.</p><button type="button" style={{ backgroundColor: previewColor, color: previewTextColor }}>Create a request <Icon name="forward" size={13} /></button><div className="branding-preview-card"><span className="branding-preview-card-icon" style={{ color: previewColor }}><Icon name="ticket" size={15} /></span><span><strong>My requests</strong><small>Track your open support conversations</small></span><Icon name="chevron-right" size={14} /></div></div>
          </div>
          <p className="branding-preview-note"><Icon name="check" size={13} /> Changes update the portal after you save.</p>
        </aside>
      </div>
    </>
  </SettingSection>
}

function PortalSettingsTab({ settings, portalInfo, update, error, message }: {
  settings: WorkspaceSettings
  portalInfo: { slug: string; url: string } | null
  update: (patch: Partial<WorkspaceSettings>) => Promise<void>
  error: string | null
  message: string | null
}) {
  const [slugDraft, setSlugDraft] = useState(settings.portal.slug)
  const [slugInvalid, setSlugInvalid] = useState(false)
  const [copied, setCopied] = useState(false)
  const [welcomeDraft, setWelcomeDraft] = useState(settings.portal.welcome_message)
  const [domainDraft, setDomainDraft] = useState('')
  const portalUrl = portalInfo?.url ?? ''
  const displaySlug = portalInfo?.slug ?? ''

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
  }

  const saveSlug = async () => {
    const next = slugDraft.trim().toLowerCase()
    if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(next)) { setSlugInvalid(true); return }
    setSlugInvalid(false)
    await update({ portal: { ...settings.portal, slug: next } })
  }

  const saveWelcome = () => {
    if (welcomeDraft === settings.portal.welcome_message) return
    void update({ portal: { ...settings.portal, welcome_message: welcomeDraft.trim() } })
  }

  const addDomain = () => {
    const next = domainDraft.trim().toLowerCase().replace(/^@/, '')
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(next)) return
    if (settings.portal.registration_domains.includes(next)) { setDomainDraft(''); return }
    void update({ portal: { ...settings.portal, registration_domains: [...settings.portal.registration_domains, next] } })
    setDomainDraft('')
  }

  const removeDomain = (domain: string) => {
    void update({ portal: { ...settings.portal, registration_domains: settings.portal.registration_domains.filter((d) => d !== domain) } })
  }

  return <SettingSection title="Customer portal" description="Your team's self-service home for raising requests, tracking tickets, and reading the knowledge base."><>
    {error && <Alert kind="error">{error}</Alert>}
    {message && <Alert kind="info">{message}</Alert>}

    <div className="portal-address-card">
      <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="external" size={15} /></span><div><h3>Portal address</h3><p>Send this link to your staff — this is how they find the IT portal.</p></div></div>
      <div className="portal-url-row">
        <code className="portal-url mono">{portalUrl || 'Loading portal address…'}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyLink()} disabled={!portalUrl}><Icon name="copy" size={14} />{copied ? 'Copied' : 'Copy link'}</button>
        {portalUrl ? <a className="btn btn-ghost btn-sm" href={portalUrl} target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open portal</a> : null}
      </div>
      <div className="portal-slug-row">
        <Field label="Portal address slug" hint="Lowercase letters, numbers, and hyphens. Leave blank to use your organisation slug.">
          <div className="settings-inline-field">
            <input className={`field-input mono${slugInvalid ? ' field-input-invalid' : ''}`} value={slugDraft} onChange={(e) => { setSlugDraft(e.target.value.toLowerCase()); setSlugInvalid(false) }} placeholder={displaySlug} maxLength={64} aria-label="Portal URL path" />
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveSlug()} disabled={slugDraft.trim().toLowerCase() === settings.portal.slug}><Icon name="save" size={14} />Update link</button>
          </div>
        </Field>
        {slugInvalid ? <p className="field-error">Use lowercase letters, numbers, and hyphens only (no spaces or special characters).</p> : null}
      </div>
    </div>

    <div className="portal-address-card">
      <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="mail" size={15} /></span><div><h3>Portal welcome message</h3><p>Shown on the public portal home so requesters see a friendly, on-brand line.</p></div></div>
      <div className="portal-slug-row">
        <Field label="Welcome text" hint="A short greeting, at most 500 characters.">
          <div className="settings-inline-field">
            <textarea className="field-input portal-welcome-input" rows={2} value={welcomeDraft} onChange={(e) => setWelcomeDraft(e.target.value)} maxLength={500} placeholder="Welcome to our support centre — how can we help today?" aria-label="Portal welcome message" />
            <button type="button" className="btn btn-primary btn-sm" onClick={saveWelcome} disabled={welcomeDraft.trim() === settings.portal.welcome_message}><Icon name="save" size={14} />Save message</button>
          </div>
        </Field>
      </div>
    </div>

    <div className="portal-toggles">
      <ToggleRow label="Enable customer portal" description="Allow requesters to view and raise support requests at the portal address." checked={settings.portal.enabled} onChange={(v) => void update({ portal: { ...settings.portal, enabled: v } })} />
      <ToggleRow label="Show public knowledge base" description="Let anyone with the portal address read articles marked Public — no sign-in required." checked={settings.portal.allow_public_kb} onChange={(v) => void update({ portal: { ...settings.portal, allow_public_kb: v } })} />
      <ToggleRow label="Show device context" description="Include linked device details when a requester views a ticket." checked={settings.portal.show_device_context} onChange={(v) => void update({ portal: { ...settings.portal, show_device_context: v } })} />
      <ToggleRow label="Allow requester resolution" description="Let requesters mark their own resolved tickets as complete." checked={settings.portal.allow_customer_resolution} onChange={(v) => void update({ portal: { ...settings.portal, allow_customer_resolution: v } })} />
      <ToggleRow label="Allow self-service registration" description="Let anyone with the portal address create an end-user account — perfect for organisations that don't manage identities in IT." checked={settings.portal.allow_registration} onChange={(v) => void update({ portal: { ...settings.portal, allow_registration: v } })} />
    </div>

    {settings.portal.allow_registration ? <div className="portal-address-card">
      <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="shield" size={15} /></span><div><h3>Allowed registration domains</h3><p>Restrict sign-up to work email addresses. Leave empty to allow any email.</p></div></div>
      {settings.portal.registration_domains.length > 0 ? (
        <div className="portal-domain-chips">
          {settings.portal.registration_domains.map((domain) => (
            <span className="portal-domain-chip" key={domain}>@{domain}<button type="button" onClick={() => removeDomain(domain)} aria-label={`Remove ${domain}`}><Icon name="delete" size={12} /></button></span>
          ))}
        </div>
      ) : <p className="settings-note">Any email domain may register while this list is empty.</p>}
      <div className="settings-inline-field portal-domain-add">
        <input className="field-input mono" value={domainDraft} onChange={(e) => setDomainDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDomain() } }} placeholder="example.com" aria-label="Add allowed domain" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={addDomain}><Icon name="add" size={14} />Add domain</button>
      </div>
    </div> : null}

    <div className="portal-how-it-works">
      <div className="branding-section-heading"><span className="branding-section-icon"><Icon name="user" size={15} /></span><div><h3>How your staff use it</h3><p>Three steps, then they are self-sufficient.</p></div></div>
      <ol className="portal-steps">
        <li><strong>Share the link</strong><span>Send the portal address above by email, intranet, or a sign on your reception desk.</span></li>
        <li><strong>They sign in with work email</strong><span>Staff with accounts sign in with their ReyDesk email. New requesters can register at the portal when registration is enabled, or IT can invite them — with magic links enabled (@Settings → Authentication), they receive a one-click sign-in email.</span></li>
        <li><strong>Request, track, and read</strong><span>They raise requests, follow their tickets, and browse published knowledge-base articles — without seeing any internal console tools.</span></li>
      </ol>
    </div>
  </></SettingSection>
}

function OperationalSettings({ tab }: { tab: 'portal' | 'remote' | 'devices' | 'monitoring' | 'data' }) {
  const { settings, portalInfo, loading, error, setError, save } = useWorkspaceSettings()
  const [message, setMessage] = useState<string | null>(null)
  if (loading || !settings) return <div className="settings-card"><span className="etch">Loading settings…</span></div>
  const update = async (patch: Partial<WorkspaceSettings>) => { try { await save(patch); setMessage('Settings saved.') } catch (e) { setError(e instanceof Error ? e.message : 'Save failed') } }
  if (tab === 'portal') return <PortalSettingsTab settings={settings} portalInfo={portalInfo} update={update} error={error} message={message} />
  if (tab === 'remote') return <SettingSection title="Remote support" description="Set safe defaults for attended and unattended support sessions. Endpoint consent remains mandatory for attended access."><>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}<ToggleRow label="Require endpoint consent" description="Never allow attended screen sharing to start without explicit user approval." checked={settings.remote_support.require_consent} onChange={(v) => void update({ remote_support: { ...settings.remote_support, require_consent: v } })} /><div className="settings-form-grid"><Field label="Default session expiry (minutes)"><input className="field-input" type="number" min={5} max={1440} value={settings.remote_support.default_expiry_minutes} onChange={(e) => void update({ remote_support: { ...settings.remote_support, default_expiry_minutes: Number(e.target.value) } })} /></Field><Field label="Default recording mode"><select className="field-input" value={settings.remote_support.default_recording_mode} onChange={(e) => void update({ remote_support: { ...settings.remote_support, default_recording_mode: e.target.value as WorkspaceSettings['remote_support']['default_recording_mode'] } })}><option value="off">Off</option><option value="metadata">Metadata only</option><option value="video">Video</option></select></Field><Field label="Recording retention (days)"><input className="field-input" type="number" min={1} max={3650} value={settings.remote_support.recording_retention_days} onChange={(e) => void update({ remote_support: { ...settings.remote_support, recording_retention_days: Number(e.target.value) } })} /></Field></div><ToggleRow label="Allow file transfer by default" description="New sessions may request file transfer; technicians can still scope each session." checked={settings.remote_support.allow_file_transfer} onChange={(v) => void update({ remote_support: { ...settings.remote_support, allow_file_transfer: v } })} /><ToggleRow label="Allow clipboard by default" description="Enable clipboard synchronization in newly generated support sessions." checked={settings.remote_support.allow_clipboard} onChange={(v) => void update({ remote_support: { ...settings.remote_support, allow_clipboard: v } })} /><ToggleRow label="Allow elevated terminal by default" description="Keep disabled unless your support policy explicitly permits terminal access." checked={settings.remote_support.allow_terminal} onChange={(v) => void update({ remote_support: { ...settings.remote_support, allow_terminal: v } })} /><ToggleRow label="Allow process and service management" description="Controls the default request; endpoint consent and technician permissions still apply." checked={settings.remote_support.allow_system_manage} onChange={(v) => void update({ remote_support: { ...settings.remote_support, allow_system_manage: v } })} /></></SettingSection>
  if (tab === 'devices') return <SettingSection title="Devices & agents" description="Choose how enrolled endpoints report health and how new devices join the organization."><>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}<div className="settings-form-grid"><Field label="Offline after (minutes)" hint="Used to classify a device as offline."><input className="field-input" type="number" min={1} max={1440} value={settings.endpoints.offline_after_minutes} onChange={(e) => void update({ endpoints: { ...settings.endpoints, offline_after_minutes: Number(e.target.value) } })} /></Field><Field label="Heartbeat interval (seconds)"><input className="field-input" type="number" min={10} max={3600} value={settings.endpoints.heartbeat_interval_seconds} onChange={(e) => void update({ endpoints: { ...settings.endpoints, heartbeat_interval_seconds: Number(e.target.value) } })} /></Field><Field label="Enrollment code expiry (minutes)"><input className="field-input" type="number" min={5} max={1440} value={settings.endpoints.enrollment_code_expiry_minutes} onChange={(e) => void update({ endpoints: { ...settings.endpoints, enrollment_code_expiry_minutes: Number(e.target.value) } })} /></Field></div><ToggleRow label="Allow self-enrollment" description="Permit technicians to generate one-time enrollment codes from the Devices page." checked={settings.endpoints.allow_self_enrollment} onChange={(v) => void update({ endpoints: { ...settings.endpoints, allow_self_enrollment: v } })} /></></SettingSection>
  if (tab === 'monitoring') return <SettingSection title="Monitoring defaults" description="Set the default response when endpoint metrics generate alerts. Individual rules can override these values."><>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}<ToggleRow label="Create tickets by default" description="New monitoring rules start with automatic ticket creation enabled." checked={settings.monitoring.create_tickets_by_default} onChange={(v) => void update({ monitoring: { ...settings.monitoring, create_tickets_by_default: v } })} /><Field label="Offline device response" hint="Laptops that are shut down can raise alerts without opening tickets."><select className="field-input" value={settings.monitoring.offline_ticket_mode} onChange={(e) => void update({ monitoring: { ...settings.monitoring, offline_ticket_mode: e.target.value as WorkspaceSettings['monitoring']['offline_ticket_mode'] } })}><option value="alert_only">Alert only — recommended for laptops</option><option value="ticket">Open a ticket</option></select></Field><div className="settings-form-grid"><Field label="Default ticket priority"><select className="field-input" value={settings.monitoring.default_ticket_priority} onChange={(e) => void update({ monitoring: { ...settings.monitoring, default_ticket_priority: e.target.value } })}><option value="p1">P1 — Critical</option><option value="p2">P2 — High</option><option value="p3">P3 — Normal</option><option value="p4">P4 — Low</option></select></Field><Field label="Default severity"><select className="field-input" value={settings.monitoring.default_severity} onChange={(e) => void update({ monitoring: { ...settings.monitoring, default_severity: e.target.value as WorkspaceSettings['monitoring']['default_severity'] } })}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></Field></div><p className="settings-note"><Icon name="alert" size={14} /> Individual monitoring rules always take precedence over these defaults.</p></></SettingSection>
  return <SettingSection title="Data retention" description="Retention policy guidance for tenant-scoped operational data. Actual purge jobs must be enabled in production infrastructure."><>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}<div className="settings-form-grid"><Field label="Audit logs (days)"><input className="field-input" type="number" min={30} max={3650} value={settings.data_retention.audit_days} onChange={(e) => void update({ data_retention: { ...settings.data_retention, audit_days: Number(e.target.value) } })} /></Field><Field label="Session recordings (days)"><input className="field-input" type="number" min={1} max={3650} value={settings.data_retention.recording_days} onChange={(e) => void update({ data_retention: { ...settings.data_retention, recording_days: Number(e.target.value) } })} /></Field><Field label="Notifications (days)"><input className="field-input" type="number" min={7} max={3650} value={settings.data_retention.notification_days} onChange={(e) => void update({ data_retention: { ...settings.data_retention, notification_days: Number(e.target.value) } })} /></Field></div><p className="settings-note"><Icon name="clock" size={14} /> Changes are stored as policy metadata. Configure scheduled purge workers before relying on them for compliance.</p></></SettingSection>
}

function AiTriageSettings() {
  const { settings, loading, error, setError, save } = useWorkspaceSettings()
  const [message, setMessage] = useState<string | null>(null)
  if (loading || !settings) return <div className="settings-card"><span className="etch">Loading AI triage settings…</span></div>
  const update = async (patch: Partial<WorkspaceSettings>) => {
    try { await save(patch); setMessage('AI triage settings saved.') }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save AI triage settings') }
  }
  return <SettingSection title="AI ticket triage" description="Let ReyDesk ask safe diagnostic questions and resolve routine requests, while handing risky or uncertain work to a technician.">
    <>{error && <Alert kind="error">{error}</Alert>}{message && <Alert kind="info">{message}</Alert>}
      <ToggleRow label="Enable AI ticket triage" description="Start bounded triage for portal, email, and phone-originated tickets when AI is configured." checked={settings.ai_triage.enabled} onChange={(value) => void update({ ai_triage: { ...settings.ai_triage, enabled: value } })} />
      <ToggleRow label="Allow public AI replies" description="AI may post one auditable public reply at a time and email the requester; it never sends internal notes." checked={settings.ai_triage.autoReply} disabled={!settings.ai_triage.enabled} onChange={(value) => void update({ ai_triage: { ...settings.ai_triage, autoReply: value } })} />
      <ToggleRow label="Allow high-confidence auto-resolution" description="Only close a ticket when the model reports strong evidence that the requester is fixed and the confidence threshold is met." checked={settings.ai_triage.autoResolve} disabled={!settings.ai_triage.enabled} onChange={(value) => void update({ ai_triage: { ...settings.ai_triage, autoResolve: value } })} />
      <div className="settings-form-grid">
        <Field label="Maximum question rounds" hint="AI asks one diagnostic question per round before handoff."><input className="field-input" type="number" min={1} max={8} value={settings.ai_triage.maxRounds} disabled={!settings.ai_triage.enabled} onChange={(event) => void update({ ai_triage: { ...settings.ai_triage, maxRounds: Number(event.target.value) } })} /></Field>
        <Field label="Resolution confidence" hint="0.92 is the recommended production floor."><input className="field-input" type="number" min={0.5} max={0.99} step={0.01} value={settings.ai_triage.resolveConfidence} disabled={!settings.ai_triage.enabled} onChange={(event) => void update({ ai_triage: { ...settings.ai_triage, resolveConfidence: Number(event.target.value) } })} /></Field>
      </div>
      <p className="settings-note"><Icon name="shield" size={14} /> AI cannot run terminal commands, change devices, access secrets, or bypass consent. Technicians can stop triage from the ticket.</p>
    </>
  </SettingSection>
}

function IntegrationsSettings() {
  return <div className="settings-card-grid"><SettingSection title="Webhooks" description="Deliver ticket, session, device, and SLA events to external systems."><p className="settings-note">Configure signed Slack, Teams, or generic webhook endpoints in the integrations workspace.</p><NavLink className="btn btn-primary btn-sm settings-card-link" to="/integrations"><Icon name="external" size={14} />Open webhook integrations</NavLink></SettingSection><SettingSection title="Developer marketplace" description="Install approved extensions and connect operational tools."><p className="settings-note">Review available apps, capabilities, and tenant installations.</p><NavLink className="btn btn-ghost btn-sm settings-card-link" to="/marketplace"><Icon name="external" size={14} />Open marketplace</NavLink></SettingSection><SettingSection title="Email and identity connectors" description="Email, Entra ID, and directory connectors are managed in their dedicated settings areas."><div className="settings-link-list"><NavLink to="/settings/email">Email channels <Icon name="forward" size={14} /></NavLink><NavLink to="/settings/active-directory">Directory sync <Icon name="forward" size={14} /></NavLink></div></SettingSection></div>
}

function ApiSettings() {
  return <PublicApiSettingsPage />
}

function SettingsHome() {
  const navigate = useNavigate()
  const [coverage, setCoverage] = useState<WorkspaceSettings | null>(null)
  useEffect(() => { api<{ settings: WorkspaceSettings }>('/tenant/settings').then((r) => setCoverage(normalizeWorkspaceSettings(r.settings))).catch(() => {}) }, [])
  const configured = useMemo(() => coverage ? [coverage.portal.enabled, coverage.remote_support.require_consent, coverage.endpoints.allow_self_enrollment, coverage.monitoring.create_tickets_by_default].filter(Boolean).length : 0, [coverage])
  return <div className="settings-overview"><div className="settings-overview-hero"><div><span className="settings-eyebrow">Workspace control centre</span><h2>Settings</h2><p>Configure ReyDesk by responsibility instead of hunting through unrelated screens.</p></div><div className="settings-overview-stat"><strong>{configured}/4</strong><span>core safeguards enabled</span></div></div><OrganizationSettings /><div className="settings-card-grid"><SettingSection title="Security baseline" description="MFA, passkeys, directory sync, and public API access."><p className="settings-note"><Icon name="shield" size={14} /> Review authentication policy and connected identity providers.</p><button className="btn btn-ghost btn-sm settings-card-link" onClick={() => navigate('/settings/security')}><Icon name="forward" size={14} />Review security</button></SettingSection><SettingSection title="Operations baseline" description="Remote support, device health, monitoring, and retention defaults."><p className="settings-note"><Icon name="monitor" size={14} /> Keep consent, enrollment, and alert defaults explicit.</p><button className="btn btn-ghost btn-sm settings-card-link" onClick={() => navigate('/settings/remote')}><Icon name="forward" size={14} />Review operations</button></SettingSection><SettingSection title="Account administration" description="Manage people and commercial settings without leaving the product."><p className="settings-note"><Icon name="user" size={14} /> Staff and billing remain available from the Account group.</p><div className="settings-card-actions"><NavLink className="btn btn-ghost btn-sm" to="/staff">Staff</NavLink><NavLink className="btn btn-ghost btn-sm" to="/billing">Billing</NavLink></div></SettingSection></div></div>
}

export default function SettingsPage() {
  const location = useLocation()
  const path = location.pathname
  const active: SettingsTab = path === '/settings' ? 'home' : path.includes('/preferences') ? 'preferences' : path.includes('/tickets') ? 'tickets' : path.includes('/email') ? 'email' : path.includes('/canned') ? 'canned' : path.includes('/notifications') ? 'notifications' : path.includes('/settings/ai') ? 'ai' : path.includes('/security') ? 'security' : path.includes('/active-directory') ? 'active-directory' : path.includes('/branding') ? 'branding' : path.includes('/portal') ? 'portal' : path.includes('/remote') ? 'remote' : path.includes('/devices') ? 'devices' : path.includes('/monitoring') ? 'monitoring' : path.includes('/data') ? 'data' : path.includes('/integrations') ? 'integrations' : path.includes('/settings/ad') ? 'ad' : 'api'
  return <Shell><div className="settings-page"><div className="page-head settings-page-head"><div className="page-head-main"><h1 className="page-title">Settings</h1><p className="page-subtitle">Organization-wide controls, operational defaults, and personal preferences.</p></div><NavLink className="btn btn-ghost btn-sm" to="/"><Icon name="back" size={14} />Back to dashboard</NavLink></div><div className="settings-layout"><SettingsNavigation active={active} /><main className="settings-content">{active === 'home' && <SettingsHome />}{active === 'preferences' && <PreferencesSettings />}{active === 'tickets' && <TicketSettingsPage />}{active === 'email' && <EmailSettingsPage />}{active === 'canned' && <CannedResponsesPage />}{active === 'notifications' && <NotificationSettingsPage />}{active === 'ai' && <AiSettingsPanel />}{active === 'security' && <SecuritySettingsPage />}
{active === 'active-directory' && <EntraSettingsPage />}{active === 'ad' && <AdSettingsPage />}{active === 'branding' && <BrandingSettings />}{active === 'portal' && <OperationalSettings tab="portal" />}{active === 'remote' && <OperationalSettings tab="remote" />}{active === 'devices' && <OperationalSettings tab="devices" />}{active === 'monitoring' && <OperationalSettings tab="monitoring" />}{active === 'data' && <OperationalSettings tab="data" />}{active === 'integrations' && <IntegrationsSettings />}{active === 'api' && <ApiSettings />}</main></div></div></Shell>
}
