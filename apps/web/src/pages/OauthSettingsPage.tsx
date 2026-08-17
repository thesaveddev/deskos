import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { createOauthClient, deleteOauthClient, listOauthClients, type OAuthClient } from '../lib/oauth.js'

const SCOPES = ['tickets:read', 'tickets:write', 'devices:read', 'devices:manage', 'audit:read']
const GRANTS = ['client_credentials', 'authorization_code'] as const

export default function OauthSettingsPage() {
  const [clients, setClients] = useState<OAuthClient[] | null>(null)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['tickets:read'])
  const [grants, setGrants] = useState<string[]>(['client_credentials'])
  const [redirectUri, setRedirectUri] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setClients((await listOauthClients()).clients)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load OAuth clients')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((s) => s !== value) : [...list, value])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setCreatedSecret(null)
    try {
      const result = await createOauthClient({
        name,
        scopes,
        grantTypes: grants as ('client_credentials' | 'authorization_code')[],
        redirectUris: grants.includes('authorization_code') && redirectUri ? [redirectUri] : undefined,
      })
      setCreatedSecret(result.clientSecret)
      setName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create client')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteOauthClient(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete client')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Public API</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {createdSecret ? <Alert kind="info">Copy this client secret now — it is shown only once: <code>{createdSecret}</code></Alert> : null}

      <div className="kb-layout">
        <section className="form-panel">
          <h2 className="channel-form-title">Register OAuth client</h2>
          <form onSubmit={(e) => void submit(e)}>
            <div className="form-row">
              <input className="field-input" placeholder="Client name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="form-row">
              <span className="field-label">Grant types</span>
              <div style={{ display: 'flex', gap: 12 }}>
                {GRANTS.map((g) => (
                  <label key={g} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={grants.includes(g)} onChange={() => setGrants(toggle(grants, g))} />
                    {g}
                  </label>
                ))}
              </div>
            </div>
            <div className="form-row">
              <span className="field-label">Scopes</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {SCOPES.map((s) => (
                  <label key={s} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes(toggle(scopes, s))} />
                    <span className="mono">{s}</span>
                  </label>
                ))}
              </div>
            </div>
            {grants.includes('authorization_code') ? (
              <div className="form-row">
                <input className="field-input mono" placeholder="Redirect URI (https://…)" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} />
              </div>
            ) : null}
            <div className="form-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || scopes.length === 0 || grants.length === 0}>
                {busy ? 'Creating…' : 'Create client'}
              </button>
            </div>
          </form>
        </section>

        <section className="form-panel">
          <h3 className="channel-title">Clients</h3>
          {clients === null ? (
            <span className="etch">Loading clients…</span>
          ) : clients.length === 0 ? (
            <p className="muted">No OAuth clients registered.</p>
          ) : (
            <ul className="channel-list">
              {clients.map((c) => (
                <li key={c.id} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name">{c.name}</span>
                    <span className="channel-meta mono">{c.grantTypes.join(', ')} · {c.scopes.join(', ')}</span>
                  </div>
                  <div className="channel-actions">
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void remove(c.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  )
}
