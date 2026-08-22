import { useCallback, useEffect, useState } from 'react'
import { Alert, Field } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import {
  createAdConnection,
  deleteAdConnection,
  diagnoseAdConnection,
  listAdActions,
  listAdConnections,
  listAdContacts,
  listAdSyncRuns,
  runAdAction,
  syncAdDevices,
  syncAdDirectory,
  testAdConnection,
  updateAdConnection,
  type AdAction,
  type AdActionType,
  type AdConnection,
  type Contact,
  type DiagnosticStep,
  type SyncRun,
} from '../lib/ad.js'

interface AdForm {
  name: string
  host: string
  port: string
  useSsl: boolean
  baseDn: string
  bindDn: string
  bindPassword: string
  enabled: boolean
}

const EMPTY_FORM: AdForm = {
  name: '', host: '', port: '389', useSsl: false, baseDn: '', bindDn: '', bindPassword: '', enabled: true,
}

const ACTIONS: AdActionType[] = ['resetPassword', 'unlockAccount', 'enableAccount', 'disableAccount']

export default function AdSettingsPage() {
  const [connections, setConnections] = useState<AdConnection[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [actions, setActions] = useState<AdAction[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [form, setForm] = useState<AdForm>(EMPTY_FORM)
  const [editing, setEditing] = useState<AdConnection | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [diagSteps, setDiagSteps] = useState<DiagnosticStep[]>([])
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagBusy, setDiagBusy] = useState(false)
  const [diagConnectionName, setDiagConnectionName] = useState('')

  const refresh = useCallback(() => {
    void listAdConnections().then((r) => setConnections(r.connections)).catch(() => undefined)
    void listAdSyncRuns().then((r) => setRuns(r.runs)).catch(() => undefined)
    void listAdActions().then((r) => setActions(r.actions)).catch(() => undefined)
    void listAdContacts().then((r) => setContacts(r.contacts)).catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function setField<K extends keyof AdForm>(key: K, value: AdForm[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const payload = {
        name: form.name,
        host: form.host,
        port: form.port ? Number(form.port) : undefined,
        useSsl: form.useSsl,
        baseDn: form.baseDn,
        bindDn: form.bindDn,
        bindPassword: form.bindPassword,
        enabled: form.enabled,
      }
      if (editing) {
        const patch: Record<string, unknown> = { ...payload }
        if (!form.bindPassword) delete patch.bindPassword
        await updateAdConnection(editing.id, patch)
        setNotice('Connection updated.')
      } else {
        await createAdConnection(payload)
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
      const r = await testAdConnection(id)
      setNotice(`Connection "${name}" is healthy (${r.users ?? 0} users visible).`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDiagnose(id: string, name: string) {
    setDiagBusy(true)
    setDiagSteps([])
    setDiagConnectionName(name)
    setDiagOpen(true)
    setError(null)
    try {
      const result = await diagnoseAdConnection(id)
      setDiagSteps(result.steps)
    } catch (e) {
      setDiagSteps([{ name: 'error', label: 'Diagnostic failed', status: 'error', detail: e instanceof Error ? e.message : 'Unknown error' }])
    } finally {
      setDiagBusy(false)
    }
  }

  async function handleSync(id: string, name: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await syncAdDirectory(id)
      setNotice(`Sync of "${name}" complete: ${r.created} created, ${r.updated} updated.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleSyncDevices(id: string, name: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await syncAdDevices(id)
      setNotice(`Device sync of "${name}" complete: ${r.created} discovered, ${r.updated} updated.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Device sync failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleAction(id: string) {
    const upn = window.prompt('User principal name (e.g. user@corp.local):')
    if (!upn) return
    const action = window.prompt(`Action for ${upn}: ${ACTIONS.join(' | ')}:`) as AdActionType | null
    if (!action || !ACTIONS.includes(action)) return
    const newPassword = action === 'resetPassword' ? window.prompt('New temporary password:') ?? undefined : undefined
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await runAdAction(id, { action, upn, newPassword })
      setNotice(`${action} on ${upn}: ${r.status} — ${r.detail}`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(id: string) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteAdConnection(id)
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
      <h2 className="channel-form-title">Active Directory (on-prem)</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Connect an on-prem domain controller over LDAP/LDAPS to sync the directory into contacts and run gated account
        actions. Bind passwords are encrypted at rest and never returned. Password reset requires an LDAPS (SSL) connection.
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <form onSubmit={handleSave} className="channel-form">
        <Field label="Display name">
          <input className="field-input" value={form.name} onChange={(e) => setField('name', e.target.value)} required />
        </Field>
        <div className="form-row">
          <Field label="Host">
            <input className="field-input" value={form.host} onChange={(e) => setField('host', e.target.value)} placeholder="dc.corp.local" required />
          </Field>
          <Field label="Port">
            <input className="field-input" type="number" value={form.port} onChange={(e) => setField('port', e.target.value)} required />
          </Field>
        </div>
        <Field label="Base DN" hint="e.g. DC=corp,DC=local">
          <input className="field-input" value={form.baseDn} onChange={(e) => setField('baseDn', e.target.value)} required />
        </Field>
        <Field label="Bind DN" hint="e.g. CN=ReyDesk Service,OU=Service Accounts,DC=corp,DC=local">
          <input className="field-input" value={form.bindDn} onChange={(e) => setField('bindDn', e.target.value)} required />
        </Field>
        <PasswordField label="Bind password" hint={editing ? 'Leave blank to keep the existing password' : undefined} className="field-input" value={form.bindPassword} onChange={(e) => setField('bindPassword', e.target.value)} required={!editing} />
        <div className="form-row">
          <label className="field checkbox-field">
            <input type="checkbox" checked={form.useSsl} onChange={(e) => setField('useSsl', e.target.checked)} />
            LDAPS (SSL)
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setField('enabled', e.target.checked)} />
            Enabled
          </label>
        </div>
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
                <span className={`status-pill ${c.enabled ? 'status-open' : 'status-resolved'}`}>{c.enabled ? 'enabled' : 'disabled'}</span>
              </div>
              <div className="channel-meta muted">
                {c.useSsl ? 'ldaps' : 'ldap'}://{c.host}:{c.port} · {c.baseDn} · {c.bindDn} · secret {c.bindPasswordMasked}
              </div>
            </div>
            <div className="channel-actions">
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleTest(c.id, c.name)}>Test</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={diagBusy} onClick={() => void handleDiagnose(c.id, c.name)}>Diagnose</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleSync(c.id, c.name)}>Sync</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleSyncDevices(c.id, c.name)}>Sync devices</button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => handleAction(c.id)}>Action</button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  setEditing(c)
                  setForm({ name: c.name, host: c.host, port: String(c.port), useSsl: c.useSsl, baseDn: c.baseDn, bindDn: c.bindDn, bindPassword: '', enabled: c.enabled })
                }}
              >
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
              <div className="channel-meta muted">{c.email}{c.staff_id ? ` · ${c.staff_id}` : ''} · {c.department ?? '—'} · {c.account_status}</div>
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

      {diagOpen ? (
        <div className="modal-backdrop" onClick={() => { if (!diagBusy) setDiagOpen(false) }}>
          <div className="modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Connection diagnostics — {diagConnectionName}</h3>
            <p className="directory-form-intro" style={{ margin: '0 0 12px' }}>Step-by-step diagnostic for this LDAP connection.</p>
            {diagBusy ? (
              <div className="diag-progress"><span className="diag-spinner" /><span>Running diagnostics…</span></div>
            ) : diagSteps.length > 0 ? (
              <div className="diag-steps">
                {diagSteps.map((step) => (
                  <div key={step.name} className={`diag-step diag-${step.status}`}>
                    <div className="diag-step-header">
                      <span className={`diag-icon diag-icon-${step.status}`}>
                        {step.status === 'ok' ? '✓' : step.status === 'warn' ? '⚠' : step.status === 'error' ? '✗' : step.status === 'running' ? '⟳' : '○'}
                      </span>
                      <span className="diag-step-label">{step.label}</span>
                      {step.durationMs != null ? <span className="diag-step-time mono">{step.durationMs}ms</span> : null}
                    </div>
                    {step.detail ? <div className="diag-step-detail">{step.detail}</div> : null}
                  </div>
                ))}
              </div>
            ) : <span className="muted">No results.</span>}
            <div style={{ marginTop: 16, textAlign: 'right' }}><button type="button" className="btn btn-ghost" onClick={() => setDiagOpen(false)}>Close</button></div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
