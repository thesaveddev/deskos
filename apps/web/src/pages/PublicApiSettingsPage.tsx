import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Alert, Field, Modal, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { createOauthClient, deleteOauthClient, listOauthClients, type OAuthClient } from '../lib/oauth.js'
import { addApiAllowlist, getApiSecurity, getApiUsage, getDeveloperOverview, removeApiAllowlist, updateApiSecurity, type ApiAllowlistEntry, type ApiScope, type ApiUsage, type DeveloperOverview } from '../lib/developer.js'

type ApiTab = 'overview' | 'clients' | 'scopes' | 'docs' | 'security'

const TABS: Array<{ id: ApiTab; label: string; description: string; icon: 'settings' | 'key' | 'shield' | 'file' | 'lock' }> = [
  { id: 'overview', label: 'Overview', description: 'API access at a glance', icon: 'settings' },
  { id: 'clients', label: 'OAuth clients', description: 'Credentials and applications', icon: 'key' },
  { id: 'scopes', label: 'Scopes', description: 'Least-privilege permissions', icon: 'shield' },
  { id: 'docs', label: 'Documentation', description: 'Endpoints and quick start', icon: 'file' },
  { id: 'security', label: 'Security', description: 'Safe integration practices', icon: 'lock' },
]

const FALLBACK_SCOPES: ApiScope[] = [
  { scope: 'tickets:read', permission: 'ticket.read', description: 'List and read tickets in your tenant' },
  { scope: 'tickets:write', permission: 'ticket.write', description: 'Create and update tickets in your tenant' },
  { scope: 'devices:read', permission: 'device.read', description: 'List enrolled devices and their status' },
  { scope: 'devices:manage', permission: 'device.manage', description: 'Manage enrolled devices' },
  { scope: 'audit:read', permission: 'audit.read', description: 'Read the tenant audit log' },
]

const GRANTS = ['client_credentials', 'authorization_code'] as const

type GrantType = (typeof GRANTS)[number]

export default function PublicApiSettingsPage() {
  const [tab, setTab] = useState<ApiTab>('overview')
  const [overview, setOverview] = useState<DeveloperOverview | null>(null)
  const [clients, setClients] = useState<OAuthClient[]>([])
  const [loading, setLoading] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['tickets:read'])
  const [grants, setGrants] = useState<GrantType[]>(['client_credentials'])
  const [redirectUri, setRedirectUri] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const confirm = useConfirm()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [developerOverview, clientResponse] = await Promise.all([getDeveloperOverview(), listOauthClients()])
      setOverview(developerOverview)
      setClients(clientResponse.clients)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load Public API settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const availableScopes = overview?.scopes ?? FALLBACK_SCOPES
  const baseUrl = overview?.baseUrl ?? window.location.origin
  const tokenUrl = overview?.auth?.tokenUrl ?? `${baseUrl}/api/v1/oauth/token`
  const authorizeUrl = overview?.auth?.authorizeUrl ?? `${baseUrl}/api/v1/oauth/authorize`
  const specUrl = overview?.specUrl ?? `${baseUrl}/api/v1/openapi.json`
  const endpointCount = overview?.endpoints?.length ?? 0

  const openCreate = () => {
    setName('')
    setScopes(['tickets:read'])
    setGrants(['client_credentials'])
    setRedirectUri('')
    setCreatedSecret(null)
    setCopied(false)
    setError(null)
    setNotice(null)
    setEditorOpen(true)
  }

  const toggle = <T extends string>(items: T[], value: T, setter: (items: T[]) => void) => {
    setter(items.includes(value) ? items.filter((item) => item !== value) : [...items, value])
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || !name.trim() || scopes.length === 0 || grants.length === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    setCreatedSecret(null)
    try {
      const result = await createOauthClient({
        name: name.trim(),
        scopes,
        grantTypes: grants,
        redirectUris: grants.includes('authorization_code') && redirectUri.trim() ? [redirectUri.trim()] : undefined,
      })
      setClients((current) => [...current, result.client])
      setEditorOpen(false)
      setCreatedSecret(result.clientSecret)
      setNotice('OAuth client created. Copy the secret now; it will not be shown again.')
      setTab('clients')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create OAuth client')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (client: OAuthClient) => {
    if (busy || !await confirm(`Delete the OAuth client “${client.name}”? Existing tokens will stop working.`, { title: 'Delete OAuth client', confirmLabel: 'Delete client', destructive: true })) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteOauthClient(client.id)
      setClients((current) => current.filter((item) => item.id !== client.id))
      setNotice(`OAuth client “${client.name}” deleted.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete OAuth client')
    } finally {
      setBusy(false)
    }
  }

  const copySecret = async () => {
    if (!createdSecret) return
    try {
      await navigator.clipboard.writeText(createdSecret)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setError('Clipboard access is unavailable. Copy the secret manually.')
    }
  }

  const clientCredentialCount = clients.filter((client) => client.grantTypes.includes('client_credentials')).length
  const delegatedCount = clients.filter((client) => client.grantTypes.includes('authorization_code')).length
  const scopeCount = useMemo(() => new Set(clients.flatMap((client) => client.scopes)).size, [clients])

  if (loading) return <div className="settings-card"><span className="etch">Loading Public API settings…</span></div>

  return (
    <div className="public-api-page">
      <div className="public-api-hero">
        <div>
          <span className="settings-eyebrow">Developer access</span>
          <h2>Public API</h2>
          <p>Build secure integrations with OAuth2, scoped access tokens, and an OpenAPI 3.1 contract.</p>
        </div>
        <div className="public-api-hero-actions">
          <a className="btn btn-ghost btn-sm" href="/api-docs" target="_blank" rel="noreferrer"><Icon name="external" size={14} />API docs</a>
          <button type="button" className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />Register client</button>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      {createdSecret ? <div className="public-api-secret"><div><strong>New client secret</strong><span>Save this value now. ReyDesk cannot reveal it again.</span></div><code>{createdSecret}</code><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copySecret()}><Icon name="copy" size={14} />{copied ? 'Copied' : 'Copy'}</button></div> : null}

      <div className="public-api-stat-grid">
        <div className="public-api-stat"><span>OAuth clients</span><strong>{clients.length}</strong><small>{clientCredentialCount} machine-to-machine · {delegatedCount} delegated</small></div>
        <div className="public-api-stat"><span>Available scopes</span><strong>{availableScopes.length}</strong><small>{scopeCount || 'None'} currently assigned</small></div>
        <div className="public-api-stat"><span>Documented endpoints</span><strong>{endpointCount}</strong><small>OpenAPI 3.1 contract</small></div>
        <div className="public-api-stat"><span>Authentication</span><strong>OAuth2</strong><small>PKCE supported for user access</small></div>
      </div>

      <div className="public-api-tabs" role="tablist" aria-label="Public API settings sections">
        {TABS.map((item) => <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`public-api-tab${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}><Icon name={item.icon} size={16} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>)}
      </div>

      {tab === 'overview' && <OverviewTab clients={clients} onClients={() => setTab('clients')} onDocs={() => setTab('docs')} baseUrl={baseUrl} />}
      {tab === 'clients' && <ClientsTab clients={clients} busy={busy} onCreate={openCreate} onDelete={(client) => void remove(client)} />}
      {tab === 'scopes' && <ScopesTab scopes={availableScopes} clients={clients} />}
      {tab === 'docs' && <DocsTab baseUrl={baseUrl} tokenUrl={tokenUrl} authorizeUrl={authorizeUrl} specUrl={specUrl} overview={overview} />}
      {tab === 'security' && <SecurityWorkspace clients={clients} />}

      <Modal open={editorOpen} onClose={() => { if (!busy) setEditorOpen(false) }} title="Register OAuth client" width={650} footer={<><button type="button" className="btn btn-ghost" onClick={() => setEditorOpen(false)} disabled={busy}>Cancel</button><button type="submit" form="oauth-client-form" className="btn btn-primary" disabled={busy || !name.trim() || scopes.length === 0 || grants.length === 0}><Icon name="save" size={14} />{busy ? 'Creating…' : 'Create client'}</button></>}>
        <form id="oauth-client-form" onSubmit={(event) => void submit(event)} className="public-api-form">
          <p className="public-api-form-intro">Create a separate client for each integration. This makes revocation and scope review safer than sharing one credential across systems.</p>
          <Field label="Client name" hint="Use a recognizable application or service name"><input className="field-input" placeholder="ITSM connector" value={name} onChange={(event) => setName(event.target.value)} required /></Field>
          <div className="public-api-form-block"><span className="field-label">Grant types</span><div className="public-api-option-grid">{GRANTS.map((grant) => <label key={grant} className="public-api-option"><input type="checkbox" checked={grants.includes(grant)} onChange={() => toggle(grants, grant, setGrants)} /><span><strong>{grant === 'client_credentials' ? 'Client credentials' : 'Authorization code + PKCE'}</strong><small>{grant === 'client_credentials' ? 'For background jobs and service integrations.' : 'For applications acting on behalf of a signed-in user.'}</small></span></label>)}</div></div>
          <div className="public-api-form-block"><span className="field-label">Allowed scopes</span><div className="public-api-scope-options">{availableScopes.map((scope) => <label key={scope.scope} className="public-api-scope-option"><input type="checkbox" checked={scopes.includes(scope.scope)} onChange={() => toggle(scopes, scope.scope, setScopes)} /><span><code>{scope.scope}</code><small>{scope.description}</small></span></label>)}</div></div>
          {grants.includes('authorization_code') ? <Field label="Redirect URI" hint="Use an exact HTTPS callback URL in production"><input className="field-input mono" placeholder="https://app.example.com/oauth/callback" value={redirectUri} onChange={(event) => setRedirectUri(event.target.value)} required /></Field> : null}
        </form>
      </Modal>
    </div>
  )
}

function OverviewTab({ clients, onClients, onDocs, baseUrl }: { clients: OAuthClient[]; onClients: () => void; onDocs: () => void; baseUrl: string }) {
  return <div className="public-api-section"><div className="public-api-section-head"><div><h3>API access at a glance</h3><p>Use this workspace to issue credentials, review permissions, and get an integration running quickly.</p></div></div><div className="public-api-overview-grid"><article className="public-api-overview-card"><span className="public-api-card-icon"><Icon name="key" size={18} /></span><h4>OAuth2 credentials</h4><p>Register one client per service and grant only the scopes it needs. Secrets are displayed once.</p><button type="button" className="btn btn-ghost btn-sm" onClick={onClients}>Manage clients <Icon name="forward" size={14} /></button></article><article className="public-api-overview-card"><span className="public-api-card-icon"><Icon name="file" size={18} /></span><h4>OpenAPI documentation</h4><p>Explore the live endpoint contract, request shapes, responses, and available scopes.</p><button type="button" className="btn btn-ghost btn-sm" onClick={onDocs}>Explore documentation <Icon name="forward" size={14} /></button></article><article className="public-api-overview-card"><span className="public-api-card-icon"><Icon name="shield" size={18} /></span><h4>Tenant-isolated access</h4><p>Tokens are bound to this organization and cannot read data from another tenant.</p><button type="button" className="btn btn-ghost btn-sm" onClick={onClients}>Review access <Icon name="forward" size={14} /></button></article></div><div className="public-api-endpoint-summary"><div><span>API base URL</span><code>{baseUrl}/api/v1</code></div><div><span>Token endpoint</span><code>{baseUrl}/api/v1/oauth/token</code></div><div><span>Spec</span><code>OpenAPI 3.1</code></div></div></div>
}

function ClientsTab({ clients, busy, onCreate, onDelete }: { clients: OAuthClient[]; busy: boolean; onCreate: () => void; onDelete: (client: OAuthClient) => void }) {
  return <div className="public-api-section"><div className="public-api-section-head"><div><h3>OAuth clients</h3><p>Keep credentials separate by integration so access can be revoked independently.</p></div><button type="button" className="btn btn-primary btn-sm" onClick={onCreate}><Icon name="add" size={14} />Register client</button></div>{clients.length === 0 ? <div className="public-api-empty"><Icon name="key" size={24} /><strong>No OAuth clients registered</strong><span>Create a client to connect an automation, integration, or application.</span><button type="button" className="btn btn-primary btn-sm" onClick={onCreate}><Icon name="add" size={14} />Create first client</button></div> : <div className="public-api-client-list">{clients.map((client) => <article key={client.id} className="public-api-client-card"><div className="public-api-client-icon"><Icon name="key" size={18} /></div><div className="public-api-client-main"><div className="public-api-client-title"><h4>{client.name}</h4><span className={`status-pill ${client.enabled ? 'status-open' : 'status-closed'}`}>{client.enabled ? 'Enabled' : 'Disabled'}</span></div><div className="public-api-client-meta"><span>Grant: <code>{client.grantTypes.join(', ')}</code></span><span>Scopes: <code>{client.scopes.join(', ')}</code></span><span>Created {new Date(client.createdAt).toLocaleDateString()}</span></div>{client.redirectUris.length > 0 ? <div className="public-api-client-redirect">Redirect: <code>{client.redirectUris.join(', ')}</code></div> : null}</div><button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => onDelete(client)}><Icon name="delete" size={14} />Delete</button></article>)}</div>}</div>
}

function ScopesTab({ scopes, clients }: { scopes: ApiScope[]; clients: OAuthClient[] }) {
  return <div className="public-api-section"><div className="public-api-section-head"><div><h3>Scope catalog</h3><p>Scopes are the permissions an OAuth client can request. Start with read access and add write or management access only when required.</p></div></div><div className="public-api-scope-list">{scopes.map((scope) => { const usedBy = clients.filter((client) => client.scopes.includes(scope.scope)).length; return <article key={scope.scope} className="public-api-scope-card"><div><code>{scope.scope}</code><span>{scope.description}</span></div><div><small>ReyDesk permission</small><code>{scope.permission}</code><small>{usedBy} client{usedBy === 1 ? '' : 's'} using this</small></div></article> })}</div></div>
}

function DocsTab({ baseUrl, tokenUrl, authorizeUrl, specUrl, overview }: { baseUrl: string; tokenUrl: string; authorizeUrl: string; specUrl: string; overview: DeveloperOverview | null }) {
  return <div className="public-api-section"><div className="public-api-section-head"><div><h3>Integration documentation</h3><p>OAuth2 endpoints and the live OpenAPI contract for ReyDesk integrations.</p></div><a className="btn btn-primary btn-sm" href={specUrl} target="_blank" rel="noreferrer"><Icon name="download" size={14} />Download OpenAPI JSON</a></div><div className="public-api-url-grid"><div><span>API base URL</span><code>{baseUrl}/api/v1</code></div><div><span>Token endpoint</span><code>{tokenUrl}</code></div><div><span>Authorization endpoint</span><code>{authorizeUrl}</code></div></div><div className="public-api-quickstart"><h4>Client-credentials quick start</h4><p>Exchange a client ID and secret for a short-lived access token, then send it as a Bearer token.</p><pre>{`curl -X POST ${tokenUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"grant_type":"client_credentials","client_id":"YOUR_ID","client_secret":"YOUR_SECRET"}'`}</pre></div><div className="public-api-quickstart"><h4>Call a protected resource</h4><p>Request only the scopes assigned to the client.</p><pre>{`curl ${baseUrl}/api/v1/public/tickets \\
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"`}</pre></div><div className="public-api-doc-links"><a className="btn btn-ghost btn-sm" href="/api-docs" target="_blank" rel="noreferrer"><Icon name="external" size={14} />Open interactive API docs</a><span>{overview?.endpoints?.length ?? 0} documented endpoint{overview?.endpoints?.length === 1 ? '' : 's'} available</span></div></div>
}

function SecurityWorkspace({ clients }: { clients: OAuthClient[] }) {
  const [security, setSecurity] = useState<{ ip_allowlist_enabled: boolean; allowlist: ApiAllowlistEntry[] } | null>(null)
  const [usage, setUsage] = useState<ApiUsage | null>(null)
  const [cidr, setCidr] = useState('')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [securityError, setSecurityError] = useState<string | null>(null)

  const loadSecurity = useCallback(async () => {
    try {
      const [settings, analytics] = await Promise.all([getApiSecurity(), getApiUsage(30)])
      setSecurity(settings)
      setUsage(analytics)
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : 'Could not load API security controls')
    }
  }, [])

  useEffect(() => { void loadSecurity() }, [loadSecurity])

  const toggleAllowlist = async () => {
    if (!security || busy) return
    setBusy(true)
    setSecurityError(null)
    try {
      setSecurity(await updateApiSecurity(!security.ip_allowlist_enabled))
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : 'Could not update the allowlist')
    } finally {
      setBusy(false)
    }
  }

  const addNetwork = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!cidr.trim() || busy) return
    setBusy(true)
    setSecurityError(null)
    try {
      const result = await addApiAllowlist(cidr.trim(), label.trim())
      setSecurity((current) => current ? { ...current, allowlist: [...current.allowlist, result.entry] } : current)
      setCidr('')
      setLabel('')
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : 'Could not add this network')
    } finally {
      setBusy(false)
    }
  }

  const removeNetwork = async (entry: ApiAllowlistEntry) => {
    if (busy) return
    setBusy(true)
    setSecurityError(null)
    try {
      await removeApiAllowlist(entry.id)
      setSecurity((current) => current ? { ...current, allowlist: current.allowlist.filter((item) => item.id !== entry.id) } : current)
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : 'Could not remove this network')
    } finally {
      setBusy(false)
    }
  }

  const errorRate = usage && usage.total > 0 ? Math.round((usage.errors / usage.total) * 100) : 0
  const maxDay = Math.max(1, ...(usage?.byDay.map((day) => day.requests) ?? [0]))

  return (
    <div className="public-api-section public-api-security-workspace">
      <div className="public-api-section-head">
        <div><h3>Security operations</h3><p>Control where integrations may connect and see how the API is being used.</p></div>
        <span className={`public-api-security-state${security?.ip_allowlist_enabled ? ' is-on' : ''}`}><Icon name="shield" size={14} />{security?.ip_allowlist_enabled ? 'Allowlist enforced' : 'Open to configured clients'}</span>
      </div>
      {securityError ? <Alert kind="error">{securityError}</Alert> : null}

      <div className="public-api-security-controls">
        <article className="public-api-control-card public-api-control-card-wide">
          <div className="public-api-control-icon"><Icon name="lock" size={18} /></div>
          <div className="public-api-control-copy"><h4>IP allowlist</h4><p>Restrict OAuth-backed API requests to approved office, VPN, or private network ranges. Add at least one range before enabling enforcement.</p></div>
          <button type="button" className={`btn btn-sm ${security?.ip_allowlist_enabled ? 'btn-primary' : 'btn-ghost'}`} disabled={!security || busy || security.allowlist.filter((entry) => entry.enabled).length === 0} onClick={() => void toggleAllowlist()}>{security?.ip_allowlist_enabled ? 'Disable' : 'Enable'}</button>
        </article>
        <article className="public-api-control-card"><span className="public-api-control-label">Requests · 30 days</span><strong>{usage?.total ?? '—'}</strong><small>{usage?.errors ?? 0} errors · {errorRate}% error rate</small></article>
        <article className="public-api-control-card"><span className="public-api-control-label">Active OAuth clients</span><strong>{clients.length}</strong><small>{clients.filter((client) => client.enabled).length} enabled</small></article>
      </div>

      <div className="public-api-security-columns">
        <section className="public-api-security-panel">
          <div className="public-api-panel-head"><div><h4>Approved networks</h4><p>Use an address for one host or CIDR for a range.</p></div><span className="mono">{security?.allowlist.length ?? 0} entries</span></div>
          <form className="public-api-allowlist-form" onSubmit={(event) => void addNetwork(event)}>
            <input className="field-input mono" value={cidr} onChange={(event) => setCidr(event.target.value)} placeholder="203.0.113.0/24" aria-label="IP address or CIDR range" />
            <input className="field-input" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Head office VPN" aria-label="Network label" />
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !cidr.trim()}><Icon name="add" size={14} />Add</button>
          </form>
          <div className="public-api-allowlist-list">
            {security?.allowlist.length ? security.allowlist.map((entry) => <div className="public-api-allowlist-row" key={entry.id}><span className="public-api-network-icon"><Icon name="globe" size={14} /></span><div><code>{entry.cidr}</code><small>{entry.label || 'No label'}</small></div><span className={`status-pill ${entry.enabled ? 'status-open' : 'status-closed'}`}>{entry.enabled ? 'Active' : 'Off'}</span><button type="button" className="btn btn-ghost btn-xs" disabled={busy} onClick={() => void removeNetwork(entry)} title={`Remove ${entry.cidr}`}><Icon name="delete" size={13} /></button></div>) : <div className="public-api-security-empty"><Icon name="globe" size={18} /><span>No approved networks yet.</span></div>}
          </div>
          <p className="public-api-security-note"><Icon name="alert" size={14} />Keep one recovery network available before enabling enforcement, or you may lock out every integration.</p>
        </section>

        <section className="public-api-security-panel">
          <div className="public-api-panel-head"><div><h4>Request activity</h4><p>Successful and failed API requests recorded by day.</p></div><span className="mono">30 days</span></div>
          {usage?.byDay.length ? <div className="public-api-usage-chart" aria-label="API requests by day">{usage.byDay.map((day) => <div className="public-api-usage-bar" key={day.day} title={`${day.day}: ${day.requests} requests, ${day.errors} errors`}><div style={{ height: `${Math.max(4, Math.round((day.requests / maxDay) * 100))}%` }} /><small>{day.day.slice(5)}</small></div>)}</div> : <div className="public-api-security-empty"><Icon name="activity" size={18} /><span>No API activity recorded yet.</span></div>}
          <div className="public-api-usage-list">{usage?.byPath.slice(0, 4).map((path) => <div key={path.path}><code>{path.path}</code><span>{path.requests}</span></div>)}</div>
        </section>
      </div>
    </div>
  )
}

function LegacySecurityTab({ clients }: { clients: OAuthClient[] }) {
  const totalScopes = new Set(clients.flatMap((c) => c.scopes)).size
  const m2mCount = clients.filter((c) => c.grantTypes.includes('client_credentials')).length
  const delegatedCount = clients.filter((c) => c.grantTypes.includes('authorization_code')).length

  return (
    <div className="public-api-section">
      <div className="public-api-section-head">
        <div><h3>Security posture</h3><p>Protect credentials, enforce least privilege, and keep integrations healthy.</p></div>
      </div>

      {/* Posture summary cards */}
      <div className="public-api-security-grid">
        <div className="public-api-security-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4>Client credentials</h4>
            <span className="public-api-security-badge security-badge-green"><Icon name="check" size={10} /> Active</span>
          </div>
          <p>{clients.length} client{clients.length !== 1 ? 's' : ''} registered. {m2mCount} machine-to-machine, {delegatedCount} delegated.</p>
        </div>
        <div className="public-api-security-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4>Scope coverage</h4>
            <span className="public-api-security-badge security-badge-amber"><Icon name="shield" size={10} /> {totalScopes} scope{totalScopes !== 1 ? 's' : ''}</span>
          </div>
          <p>{totalScopes === 0 ? 'No scopes assigned to any client yet.' : `Across ${clients.length} client${clients.length !== 1 ? 's' : ''} — review the Scopes tab to confirm least privilege.`}</p>
        </div>
        <div className="public-api-security-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4>Token lifetime</h4>
            <span className="public-api-security-badge security-badge-green"><Icon name="clock" size={10} /> Short-lived</span>
          </div>
          <p>Access tokens expire after 15 minutes. Refresh tokens last 30 days and are revoked on password change.</p>
        </div>
        <div className="public-api-security-card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h4>Tenant isolation</h4>
            <span className="public-api-security-badge security-badge-green"><Icon name="lock" size={10} /> Enforced</span>
          </div>
          <p>Tokens are bound to this organization. Row-level security prevents cross-tenant data access at the database level.</p>
        </div>
      </div>

      {/* Token lifecycle controls */}
      <div style={{ marginTop: 18 }}>
        <div className="public-api-section-head">
          <div><h3>Token lifecycle</h3><p>How access and refresh tokens behave, and what you can do about it.</p></div>
        </div>
        <div className="public-api-security-list">
          <article>
            <Icon name="clock" size={18} />
            <div>
              <h4>Access tokens expire in 15 minutes</h4>
              <p>Short-lived access tokens limit the window of exposure if a token is leaked. Clients must exchange a refresh token for a new access token automatically.</p>
            </div>
          </article>
          <article>
            <Icon name="refresh" size={18} />
            <div>
              <h4>Refresh tokens last 30 days</h4>
              <p>Refresh tokens are single-use and rotated on each exchange. If a refresh token is reused after rotation, all tokens for that client are revoked.</p>
            </div>
          </article>
          <article>
            <Icon name="key" size={18} />
            <div>
              <h4>Revoke by deleting the client</h4>
              <p>Deleting a client immediately prevents new tokens from being issued. Existing access tokens expire naturally within 15 minutes. Existing refresh tokens are invalidated.</p>
            </div>
          </article>
        </div>
      </div>

      {/* Scope enforcement */}
      <div style={{ marginTop: 18 }}>
        <div className="public-api-section-head">
          <div><h3>Scope enforcement</h3><p>Every token carries only the scopes granted to its client. The API rejects any request outside the token's scope.</p></div>
        </div>
        <div className="public-api-security-list">
          <article>
            <Icon name="shield" size={18} />
            <div>
              <h4>Least-privilege by default</h4>
              <p>Start with read-only scopes (e.g. <code>tickets:read</code>) and add write or management scopes only when the integration needs them. Review scope assignments in the Scopes tab.</p>
            </div>
          </article>
          <article>
            <Icon name="lock" size={18} />
            <div>
              <h4>Scope checks are real-time</h4>
              <p>Scopes are evaluated on every API request, not just at token issuance. If you remove a scope from a client, existing tokens lose that permission immediately.</p>
            </div>
          </article>
          <article>
            <Icon name="alert" size={18} />
            <div>
              <h4>Write scopes require caution</h4>
              <p>Scopes like <code>tickets:write</code> and <code>devices:manage</code> allow data modification. Only grant these to clients you fully control and trust.</p>
            </div>
          </article>
        </div>
      </div>

      {/* Best practices */}
      <div style={{ marginTop: 18 }}>
        <div className="public-api-section-head">
          <div><h3>Best practices</h3><p>Recommended patterns for running integrations safely in production.</p></div>
        </div>
        <div className="public-api-security-list">
          <article>
            <Icon name="key" size={18} />
            <div>
              <h4>One client per integration</h4>
              <p>Separate clients make it possible to revoke a single connector without interrupting unrelated systems. A monitoring tool should not share credentials with a ticket sync.</p>
            </div>
          </article>
          <article>
            <Icon name="lock" size={18} />
            <div>
              <h4>Protect secrets in deployment</h4>
              <p>Store client secrets in a secret manager (Vault, AWS Secrets Manager, etc.). Never commit them to source control, CI pipelines, or browser code.</p>
            </div>
          </article>
          <article>
            <Icon name="refresh" size={18} />
            <div>
              <h4>Rotate by replacement</h4>
              <p>To rotate a secret: create a replacement client, update the integration to use it, verify the new client works, then delete the old one. This avoids downtime.</p>
            </div>
          </article>
          <article>
            <Icon name="shield" size={18} />
            <div>
              <h4>Monitor token usage</h4>
              <p>Check the Audit log for unusual token exchange patterns. A spike in client-credentials grants from an unexpected IP may indicate a compromised secret.</p>
            </div>
          </article>
        </div>
      </div>

      {/* Deletion warning */}
      <div className="public-api-security-note">
        <Icon name="alert" size={16} />
        <span>Deleting a client immediately prevents new tokens from being issued. Existing access tokens remain valid until their 15-minute expiry. Refresh tokens for that client are revoked immediately.</span>
      </div>
    </div>
  )
}
