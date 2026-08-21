import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, Field, Modal, useConfirm } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import { Icon } from '../components/Icons.js'
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

type DirectoryTab = 'connections' | 'contacts' | 'sync' | 'actions' | 'setup'

const TABS: Array<{ id: DirectoryTab; label: string; description: string; icon: 'settings' | 'user' | 'refresh' | 'wrench' | 'file' }> = [
  { id: 'connections', label: 'Connections', description: 'Identity providers', icon: 'settings' },
  { id: 'contacts', label: 'Directory contacts', description: 'Synced requesters', icon: 'user' },
  { id: 'sync', label: 'Sync history', description: 'Import activity', icon: 'refresh' },
  { id: 'actions', label: 'Account actions', description: 'Administrative changes', icon: 'wrench' },
  { id: 'setup', label: 'Setup guide', description: 'Permissions and next steps', icon: 'file' },
]

export default function EntraSettingsPage() {
  const confirm = useConfirm()
  const [tab, setTab] = useState<DirectoryTab>('connections')
  const [connections, setConnections] = useState<EntraConnection[]>([])
  const [runs, setRuns] = useState<SyncRun[]>([])
  const [actions, setActions] = useState<EntraAction[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [form, setForm] = useState<EntraConnectionInput>(EMPTY_FORM)
  const [editing, setEditing] = useState<EntraConnection | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionConnection, setActionConnection] = useState<EntraConnection | null>(null)
  const [actionUpn, setActionUpn] = useState('')
  const [actionType, setActionType] = useState<'resetPassword' | 'requireMfa'>('resetPassword')
  const [actionNewPassword, setActionNewPassword] = useState('')
  const [actionBusy, setActionBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [connectionResponse, runResponse, actionResponse, contactResponse] = await Promise.all([
        listEntraConnections(),
        listSyncRuns(),
        listEntraActions(),
        listContacts(),
      ])
      setConnections(connectionResponse.connections)
      setRuns(runResponse.runs)
      setActions(actionResponse.actions)
      setContacts(contactResponse.contacts)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load directory settings')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function setField<K extends keyof EntraConnectionInput>(key: K, value: EntraConnectionInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError(null)
    setNotice(null)
    setEditorOpen(true)
  }

  function openEdit(connection: EntraConnection) {
    setEditing(connection)
    setForm({
      name: connection.name,
      azureTenantId: connection.azureTenantId,
      clientId: connection.clientId,
      clientSecret: '',
      enabled: connection.enabled,
    })
    setError(null)
    setNotice(null)
    setEditorOpen(true)
  }

  function closeEditor() {
    if (busy) return
    setEditorOpen(false)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
      setEditorOpen(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      await refresh()
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
      const result = await testEntraConnection(id)
      setNotice(`Connection “${name}” is healthy (${result.users ?? 0} users visible).`)
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
      const result = await syncEntraDirectory(id)
      setNotice(`Sync of “${name}” complete: ${result.created} created, ${result.updated} updated.`)
      await refresh()
      setTab('sync')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed')
    } finally {
      setBusy(false)
    }
  }

  function openAction(connection: EntraConnection) {
    setActionConnection(connection)
    setActionUpn('')
    setActionType('resetPassword')
    setActionNewPassword('')
    setError(null)
    setNotice(null)
  }

  async function submitAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!actionConnection || actionBusy || !actionUpn.trim()) return
    setActionBusy(true)
    setError(null)
    setNotice(null)
    const upn = actionUpn.trim()
    try {
      const body = actionType === 'resetPassword'
        ? { action: 'resetPassword' as const, upn, newPassword: actionNewPassword || undefined }
        : { action: 'requireMfa' as const, upn }
      const result = await runEntraAction(actionConnection.id, body)
      setNotice(`${body.action} on ${upn}: ${result.status} — ${result.detail}`)
      setActionConnection(null)
      await refresh()
      setTab('actions')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setActionBusy(false)
    }
  }

  async function handleDelete(connection: EntraConnection) {
    if (!await confirm(`Remove the “${connection.name}” directory connection?`, { title: 'Remove directory connection', confirmLabel: 'Remove connection', destructive: true })) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteEntraConnection(connection.id)
      setNotice('Connection removed.')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  const enabledConnections = connections.filter((connection) => connection.enabled).length
  const lastRun = runs[0]

  return (
    <div className="directory-page">
      <div className="directory-hero">
        <div className="directory-hero-copy">
          <span className="settings-eyebrow">Identity and access</span>
          <h2 className="channel-form-title">Active Directory & Entra ID</h2>
          <p className="directory-hero-description">
            Connect Microsoft Entra ID to sync requesters, test directory access, and perform controlled account actions.
            Secrets are encrypted at rest and never returned by the API.
          </p>
        </div>
        <div className="directory-hero-icon"><Icon name="shield" size={28} /></div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="directory-stat-grid" aria-label="Directory summary">
        <div className="directory-stat"><span>Connections</span><strong>{connections.length}</strong><small>{enabledConnections} enabled</small></div>
        <div className="directory-stat"><span>Synced contacts</span><strong>{contacts.length}</strong><small>Available as requesters</small></div>
        <div className="directory-stat"><span>Sync runs</span><strong>{runs.length}</strong><small>{lastRun ? `Last run ${lastRun.status}` : 'No sync yet'}</small></div>
        <div className="directory-stat"><span>Account actions</span><strong>{actions.length}</strong><small>Audited requests</small></div>
      </div>

      <div className="directory-tabs" role="tablist" aria-label="Directory settings sections">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`directory-tab${tab === item.id ? ' active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            <Icon name={item.icon} size={16} />
            <span><strong>{item.label}</strong><small>{item.description}</small></span>
          </button>
        ))}
      </div>

      {tab === 'connections' && (
        <section className="directory-section" role="tabpanel">
          <div className="directory-section-head">
            <div><h3>Directory connections</h3><p>Manage the identity providers that ReyDesk can read from.</p></div>
            <button type="button" className="btn btn-primary" onClick={openCreate}><Icon name="add" size={15} />Add connection</button>
          </div>
          <div className="directory-connection-list">
            {connections.map((connection) => (
              <article key={connection.id} className="directory-connection-card">
                <div className="directory-connection-main">
                  <div className="directory-connection-title">
                    <span className="directory-provider-icon"><Icon name="user" size={17} /></span>
                    <div><h4>{connection.name}</h4><span className={`status-pill ${connection.enabled ? 'status-open' : 'status-resolved'}`}>{connection.enabled ? 'Enabled' : 'Disabled'}</span></div>
                  </div>
                  <p className="directory-connection-meta">Tenant {connection.azureTenantId} · Client {connection.clientId} · Secret {connection.clientSecretMasked}</p>
                </div>
                <div className="directory-connection-actions">
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void handleTest(connection.id, connection.name)}><Icon name="check" size={14} />Test</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void handleSync(connection.id, connection.name)}><Icon name="refresh" size={14} />Sync</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => openAction(connection)}><Icon name="wrench" size={14} />Action</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => openEdit(connection)}><Icon name="edit" size={14} />Edit</button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void handleDelete(connection)}><Icon name="delete" size={14} />Remove</button>
                </div>
              </article>
            ))}
            {connections.length === 0 ? <div className="directory-empty"><Icon name="settings" size={24} /><strong>No directory connections yet</strong><span>Add an Entra ID app registration to begin syncing users.</span><button type="button" className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />Add first connection</button></div> : null}
          </div>
        </section>
      )}

      {tab === 'contacts' && (
        <section className="directory-section" role="tabpanel">
          <div className="directory-section-head"><div><h3>Directory contacts</h3><p>People imported from Entra ID and available as ticket requesters.</p></div><span className="directory-section-count">{contacts.length} contacts</span></div>
          <div className="directory-table-wrap">
            <table className="directory-table"><thead><tr><th>Name</th><th>Email</th><th>Department</th><th>Account status</th></tr></thead><tbody>
              {contacts.map((contact) => <tr key={contact.id}><td><strong>{contact.name}</strong></td><td className="mono">{contact.email}</td><td>{contact.department ?? '—'}</td><td><span className="status-pill status-open">{contact.account_status}</span></td></tr>)}
              {contacts.length === 0 ? <tr><td colSpan={4} className="directory-table-empty">No contacts synced yet. Run a directory sync from the Connections tab.</td></tr> : null}
            </tbody></table>
          </div>
        </section>
      )}

      {tab === 'sync' && (
        <section className="directory-section" role="tabpanel">
          <div className="directory-section-head"><div><h3>Sync history</h3><p>Review imports, changes, and errors across your directory connections.</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}><Icon name="refresh" size={14} />Refresh</button></div>
          <div className="directory-table-wrap"><table className="directory-table"><thead><tr><th>Connection</th><th>Status</th><th>Fetched</th><th>Created</th><th>Updated</th><th>Started</th><th>Details</th></tr></thead><tbody>
            {runs.map((run) => <tr key={run.id}><td>{run.connection_name ?? 'Deleted connection'}</td><td><span className={`status-pill ${run.status === 'ok' ? 'status-open' : run.status === 'error' ? 'status-closed' : 'status-new'}`}>{run.status}</span></td><td>{run.fetched}</td><td>{run.created}</td><td>{run.updated}</td><td className="mono">{new Date(run.started_at).toLocaleString()}</td><td>{run.error ?? '—'}</td></tr>)}
            {runs.length === 0 ? <tr><td colSpan={7} className="directory-table-empty">No sync runs yet.</td></tr> : null}
          </tbody></table></div>
        </section>
      )}

      {tab === 'actions' && (
        <section className="directory-section" role="tabpanel">
          <div className="directory-section-head"><div><h3>Account actions</h3><p>Audited actions requested against directory accounts, including MFA requirements and password resets.</p></div></div>
          <div className="directory-table-wrap"><table className="directory-table"><thead><tr><th>Action</th><th>Target</th><th>Status</th><th>Requested by</th><th>Requested</th><th>Details</th></tr></thead><tbody>
            {actions.map((action) => <tr key={action.id}><td><strong>{action.action}</strong></td><td className="mono">{action.target_upn}</td><td><span className={`status-pill ${action.status === 'ok' ? 'status-open' : action.status === 'error' ? 'status-closed' : 'status-new'}`}>{action.status}</span></td><td>{action.actor_name ?? '—'}</td><td className="mono">{new Date(action.created_at).toLocaleString()}</td><td>{action.detail ?? '—'}</td></tr>)}
            {actions.length === 0 ? <tr><td colSpan={6} className="directory-table-empty">No account actions have been requested.</td></tr> : null}
          </tbody></table></div>
        </section>
      )}

      {tab === 'setup' && (
        <section className="directory-section" role="tabpanel">
          <div className="directory-section-head"><div><h3>Setup guide</h3><p>Use a least-privilege app registration and keep administrative actions deliberately scoped.</p></div></div>
          <div className="directory-guide-grid">
            <article className="directory-guide-card"><span className="directory-guide-number">01</span><h4>Create an app registration</h4><p>In Microsoft Entra admin center, create a single-tenant application and copy its Directory (tenant) ID and Application (client) ID.</p></article>
            <article className="directory-guide-card"><span className="directory-guide-number">02</span><h4>Grant Graph permissions</h4><p>Grant only the permissions your workflow needs. Read-only directory sync is separate from account actions such as password reset or MFA enforcement.</p></article>
            <article className="directory-guide-card"><span className="directory-guide-number">03</span><h4>Create a client secret</h4><p>Store the secret securely, enter it once in the connection form, and rotate it regularly. ReyDesk never displays the raw secret after saving.</p></article>
            <article className="directory-guide-card"><span className="directory-guide-number">04</span><h4>Test before syncing</h4><p>Use Test to validate credentials and Graph access. Run Sync only after the connection reports healthy.</p></article>
          </div>
          <div className="directory-warning"><Icon name="alert" size={17} /><span><strong>Security reminder:</strong> Directory actions are powerful. Restrict access to this settings page to trusted administrators and review the Account actions tab regularly.</span></div>
        </section>
      )}

      <Modal
        open={editorOpen}
        onClose={closeEditor}
        title={editing ? 'Edit directory connection' : 'Add Entra ID connection'}
        width={620}
        footer={<><button type="button" className="btn btn-ghost" onClick={closeEditor} disabled={busy}>Cancel</button><button type="submit" form="entra-connection-form" className="btn btn-primary" disabled={busy}><Icon name="save" size={14} />{busy ? 'Saving…' : editing ? 'Save changes' : 'Add connection'}</button></>}
      >
        <form id="entra-connection-form" onSubmit={(event) => void handleSave(event)} className="directory-form">
          <p className="directory-form-intro">Use an Entra ID app registration with client-credentials authentication. All fields are required for a new connection.</p>
          <Field label="Display name"><input className="field-input" value={form.name} onChange={(event) => setField('name', event.target.value)} placeholder="Corporate Microsoft 365" required /></Field>
          <Field label="Azure tenant ID" hint="Directory (tenant) ID from the app registration"><input className="field-input" value={form.azureTenantId} onChange={(event) => setField('azureTenantId', event.target.value)} required /></Field>
          <Field label="Client ID"><input className="field-input" value={form.clientId} onChange={(event) => setField('clientId', event.target.value)} required /></Field>
          <PasswordField label="Client secret" hint={editing ? 'Leave blank to keep the existing secret' : 'The secret is encrypted and will not be shown again'} className="field-input" value={form.clientSecret} onChange={(event) => setField('clientSecret', event.target.value)} required={!editing} />
          <label className="field checkbox-field"><input type="checkbox" checked={form.enabled} onChange={(event) => setField('enabled', event.target.checked)} />Enabled</label>
        </form>
      </Modal>

      <Modal
        open={Boolean(actionConnection)}
        onClose={() => { if (!actionBusy) setActionConnection(null) }}
        title={actionConnection ? `Directory action — ${actionConnection.name}` : 'Directory action'}
        width={520}
        footer={<>
          <button type="button" className="btn btn-ghost" onClick={() => setActionConnection(null)} disabled={actionBusy}>Cancel</button>
          <button type="submit" form="entra-action-form" className="btn btn-primary" disabled={actionBusy || !actionUpn.trim() || (actionType === 'resetPassword' && !actionNewPassword.trim())}>
            <Icon name="wrench" size={14} />{actionBusy ? 'Running…' : 'Run action'}
          </button>
        </>}
      >
        <form id="entra-action-form" onSubmit={(event) => void submitAction(event)} className="directory-form">
          <p className="directory-form-intro">Perform a scoped account action on a directory user. The action is recorded in the audit trail and appears in the Account actions tab.</p>
          <Field label="User principal name" hint="e.g. user@domain.com">
            <input className="field-input mono" value={actionUpn} onChange={(event) => setActionUpn(event.target.value)} placeholder="user@domain.com" required autoFocus />
          </Field>
          <Field label="Action">
            <select className="field-input" value={actionType} onChange={(event) => setActionType(event.target.value as 'resetPassword' | 'requireMfa')}>
              <option value="resetPassword">Reset password</option>
              <option value="requireMfa">Require MFA</option>
            </select>
          </Field>
          {actionType === 'resetPassword' ? (
            <Field label="New temporary password" hint="The user will be prompted to change it at next sign-in">
              <PasswordField className="field-input" value={actionNewPassword} onChange={(event) => setActionNewPassword(event.target.value)} required />
            </Field>
          ) : null}
        </form>
      </Modal>
    </div>
  )
}
