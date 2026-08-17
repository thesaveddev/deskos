import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  approveScript, createScript, deleteScript, listScriptRuns, listScripts, rejectScript, runScript, submitScript, updateScript,
  type Script, type ScriptPrivilegeLevel, type ScriptRun,
} from '../lib/scripts.js'

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  pending: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
}

interface FormState {
  name: string
  category: string
  os: string
  body: string
  privilegeLevel: ScriptPrivilegeLevel
}

const EMPTY_FORM: FormState = { name: '', category: 'general', os: 'windows', body: '', privilegeLevel: 'user' }

export default function ScriptsPage() {
  const perms = new Set(useAuth((s) => s.memberships.flatMap((m) => m.permissions)))
  const canManage = perms.has('script.manage')
  const canExecute = perms.has('script.execute')

  const [items, setItems] = useState<Script[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<Script | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [runs, setRuns] = useState<ScriptRun[] | null>(null)
  const [runsFor, setRunsFor] = useState<Script | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems((await listScripts()).scripts)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scripts')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError(null)
    setModalOpen(true)
  }

  const openEdit = (item: Script) => {
    setEditing(item)
    setForm({ name: item.name, category: item.category, os: (item.os ?? []).join(', '), body: item.body, privilegeLevel: item.privilege_level })
    setError(null)
    setModalOpen(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const os = form.os.split(',').map((s) => s.trim()).filter(Boolean)
    try {
      if (editing) {
        await updateScript(editing.id, { name: form.name, category: form.category, os, body: form.body, privilegeLevel: form.privilegeLevel })
        setNotice('Script updated (re-submit for approval if the body changed).')
      } else {
        await createScript({ name: form.name, category: form.category, os, body: form.body, privilegeLevel: form.privilegeLevel })
        setNotice('Script created as a draft.')
      }
      setModalOpen(false)
      setForm(EMPTY_FORM)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function action(fn: () => Promise<unknown>, success: string) {
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await fn()
      setNotice(success)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  async function showRuns(item: Script) {
    setError(null)
    setRunsFor(item)
    try {
      setRuns((await listScriptRuns(item.id)).runs)
    } catch (err) {
      setRuns(null)
      setError(err instanceof Error ? err.message : 'Failed to load runs')
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Script library"
        subtitle="Versioned, approval-gated scripts. Bodies are re-approved on every change."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}>New script</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Panel title="Library" empty={items !== null && items.length === 0}>
        {items === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading scripts…</div>
        ) : (
          <ul className="channel-list">
            {items.map((s) => (
              <li key={s.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{s.name} <span className="muted">v{s.version}</span></span>
                  <span className="channel-meta mono">{s.category} · {s.privilege_level} · {STATUS_LABELS[s.approval_status] ?? s.approval_status}</span>
                </div>
                <div className="channel-actions">
                  {(s.approval_status === 'draft' || s.approval_status === 'rejected') && canManage ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => void action(() => submitScript(s.id), 'Submitted for approval.')}>Submit</button>
                  ) : null}
                  {s.approval_status === 'pending' && canManage ? (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => void action(() => approveScript(s.id), 'Approved.')}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => void action(() => rejectScript(s.id), 'Rejected.')}>Reject</button>
                    </>
                  ) : null}
                  {s.approval_status === 'approved' && canExecute ? (
                    <button className="btn btn-primary btn-sm" onClick={() => void action(() => runScript(s.id, {}), 'Run recorded.')}>Run</button>
                  ) : null}
                  <button className="btn btn-ghost btn-sm" onClick={() => void showRuns(s)}>Runs</button>
                  {canManage ? <button className="btn btn-ghost btn-sm" onClick={() => openEdit(s)}>Edit</button> : null}
                  {canManage ? <button className="btn btn-ghost btn-sm" onClick={() => void action(() => deleteScript(s.id), 'Deleted.')}>Delete</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {runsFor ? (
        <>
          <div style={{ height: 16 }} />
          <Panel
            title={`Runs — ${runsFor.name}`}
            actions={<button className="btn btn-ghost btn-sm" onClick={() => { setRunsFor(null); setRuns(null) }}>Close</button>}
            empty={runs !== null && runs.length === 0}
          >
            {runs === null ? (
              <div className="etch" style={{ padding: 24 }}>Loading runs…</div>
            ) : (
              <ul className="channel-list">
                {runs.map((r) => (
                  <li key={r.id} className="channel-card">
                    <div className="channel-main">
                      <span className="channel-name">{r.actor_name ?? '—'}</span>
                      <span className="channel-meta mono">{r.started_at} · exit {r.exit_code ?? 'pending'}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) { setModalOpen(false); setEditing(null); setForm(EMPTY_FORM) } }}
        title={editing ? 'Edit script' : 'New script'}
        width={720}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setModalOpen(false); setEditing(null); setForm(EMPTY_FORM) }} disabled={busy}>Cancel</button>
            <button type="submit" form="script-form" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.body.trim()}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create script'}
            </button>
          </>
        }
      >
        <form id="script-form" onSubmit={(e) => void handleSubmit(e)}>
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={1} maxLength={200} required autoFocus />
          </Field>
          <div className="form-row">
            <Field label="Category">
              <input className="field-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} maxLength={60} />
            </Field>
            <Field label="OS" hint="comma-separated">
              <input className="field-input mono" value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })} />
            </Field>
          </div>
          <Field label="Privilege level">
            <select className="field-input" value={form.privilegeLevel} onChange={(e) => setForm({ ...form, privilegeLevel: e.target.value as ScriptPrivilegeLevel })}>
              <option value="user">User</option>
              <option value="elevated">Elevated</option>
            </select>
          </Field>
          <Field label="Body">
            <textarea className="field-input mono" rows={12} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={100000} />
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
