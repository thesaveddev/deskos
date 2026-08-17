import { useCallback, useEffect, useState } from 'react'
import { Alert, Field } from '../components/ui.js'
import {
  createEntraConnection,
  deleteEntraConnection,
  listContacts,
  listEntraActions,
  listEntraConnections,
  listSyncRuns,
  runEntraAction,
  syncEntraDirectory,
  testEntraConnection,
  updateEntraConnection,
  type Contact,
  type EntraAction,
  type EntraConnection,
  type EntraConnectionInput,
  type SyncRun,
} from '../lib/entra.js'

const EMPTY_FORM: EntraConnectionInput = {
  name: '',
  azureTenantId: '',
  clientId: '',
  clientSecret: '',
  enabled: true,
}

export default function EntraSettingsPage() {
  const [connections, setConnections] = useState<EntraConnection[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [actions, setActions] = useState<EntraAction[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [form, setForm] = useState<EntraConnectionInput>(EMPTY_FORM)
  const [editing, setEditing] = useState<EntraConnection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = useCallback(() => {
    void listEntraConnections().then((r) => setConnections(r.connections)).catch(() => undefined)
    void listSyncRuns().then((r) => setRuns(r.runs)).catch(() => undefined)
    void listEntraActions().then((r) => setActions(r.actions)).catch(() => undefined)
    void listContacts().then((r) => setContacts(r.contacts)).catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function setField<K extends keyof EntraConnectionInput>(key: K, value: EntraConnectionInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (editing) {
        const patch: Partial<EntraConnectionInput> = { ...form }
        if (!patch.clientSecret) delete patch.clientSecret
        await updateEntraConnection(editing.id, patch)
        setNotice('Connection updated.')
      } else {
        await createEntraConnection(form)
        setNotice('Connection added.')
      }
      setForm(EMPTY_FORM)
      setEditing(null)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(id: string, name: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await testEntraConnection(id)
      setNotice(`Connection "${name}" is healthy (${r.users ?? 0} users visible).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleSync(id: string, name: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await syncEntraDirectory(id)
      setNotice(`Sync of "${name}" complete: ${r.created} created, ${r.updated} updated.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteEntraConnection(id)
      setNotice('Connection removed.')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form-panel">
      <h2 className="channel-form-title">Microsoft 365 / Entra ID</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Connect an Entra ID app registration (client credentials) to sync your directory into contacts and run gated
        account actions. Client secrets are encrypted at rest and never returned by the API.
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <form onSubmit={handleSave} className="channel-form">
        <Field label="Display name">
          <input className="field-input" value={form.name} onChange={(e) => setField('name', e.target.value)} required />
        </Field>
        <Field label="Azure tenant ID" hint="Directory (tenant) ID from the app registration">
          <input className="field-input" value={form.azureTenantId} onChange={(e) => setField('azureTenantId', e.target.value)} required />
        </Field>
        <Field label="Client ID">
          <input className="field-input" value={form.clientId} onChange={(e) => setField('clientId', e.target.value)} required />
        </Field>
        <Field label="Client secret" hint={editing ? 'Leave blank to keep the existing secret' : undefined}>
          <input
            className="field-input"
            type="password"
            value={form.clientSecret}
            onChange={(e) => setField('clientSecret', e.target.value)}
            required={!editing}
          />
        </Field>
        <label className="field checkbox-field">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
          Enabled
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add connection'}
          </button>
          {editing ? (
            <button type="button" className="btn" disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY_FORM) }}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>

      <h3 className="channel-title" style={{ marginTop: 24 }}>Connections</h3>
      <div className="channel-list">
        {connections.length === 0 ? <div className="empty-state">No connections yet.</div> : null}
        {connections.map((c) => (
          <div key={c.id} className="channel-card">
            <div className="channel-main">
              <div className="channel-title">
                <span className="channel-name">{c.name}</span>
                <span className={`status-pill ${c.enabled ? 'status-open' : 'status-resolved'}`}>
                  {c.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="channel-meta muted">tenant {c.azureTenantId} · {c.clientId} · secret {c.clientSecretMasked}</div>
            </div>
            <div className="channel-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleTest(c.id, c.name)}>Test</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleSync(c.id, c.name)}>Sync</button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  const upn = window.prompt(`User principal name for ${c.name} (e.g. user@domain.com):`)
                  if (!upn) return
                  const action = window.confirm('OK = require MFA, Cancel = reset password')
                  setBusy(true)
                  try {
                    const body = action
                      ? { action: 'requireMfa' as const, upn }
                      : { action: 'resetPassword' as const, upn, newPassword: window.prompt('New temporary password:') ?? undefined }
                    const r = await runEntraAction(c.id, body)
                    setNotice(`${body.action} on ${upn}: ${r.status} — ${r.detail}`)
                    refresh()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Action failed')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                Action
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setEditing(c); setForm({ name: c.name, azureTenantId: c.azureTenantId, clientId: c.clientId, clientSecret: '', enabled: c.enabled }) }}>
                Edit
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleDelete(c.id)}>Remove</button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="channel-title" style={{ marginTop: 24 }}>Directory contacts ({contacts.length})</h3>
      <p className="muted">Contacts are populated by directory sync and are shared with the customer portal as requesters.</p>
      <div className="channel-list">
        {contacts.slice(0, 10).map((c) => (
          <div key={c.id} className="channel-card">
            <div className="channel-main">
              <div className="channel-title"><span className="channel-name">{c.name}</span></div>
              <div className="channel-meta muted">{c.email} · {c.department ?? '—'} · {c.account_status}</div>
            </div>
          </div>
        ))}
        {contacts.length === 0 ? <div className="empty-state">No contacts synced yet.</div> : null}
      </div>

      <h3 className="channel-title" style={{ marginTop: 24 }}>Recent sync runs</h3>
      <div className="channel-list">
        {runs.slice(0, 5).map((r) => (
          <div key={r.id} className="channel-card">
            <div className="channel-main">
              <div className="channel-title"><span className="channel-name">{r.status}</span></div>
              <div className="channel-meta muted">
                {r.connection_name ?? 'deleted connection'} · fetched {r.fetched} · created {r.created} · updated {r.updated}
                {r.error ? ` · error: ${r.error}` : ''}
              </div>
            </div>
          </div>
        ))}
        {runs.length === 0 ? <div className="empty-state">No sync runs yet.</div> : null}
      </div>

      <h3 className="channel-title" style={{ marginTop: 24 }}>Recent account actions</h3>
      <div className="channel-list">
        {actions.slice(0, 5).map((a) => (
          <div key={a.id} className="channel-card">
            <div className="channel-main">
              <div className="channel-title"><span className="channel-name">{a.action}</span></div>
              <div className="channel-meta muted">{a.target_upn} · {a.status} · {a.detail ?? ''}</div>
            </div>
          </div>
        ))}
        {actions.length === 0 ? <div className="empty-state">No account actions yet.</div> : null}
      </div>
    </div>
  )
}
