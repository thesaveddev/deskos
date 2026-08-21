import { useCallback, useEffect, useState } from 'react'
import { Alert, Field, Modal, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import {
  createCannedResponse, deleteCannedResponse, listCannedResponses, updateCannedResponse,
  type CannedResponse,
} from '../lib/canned.js'

interface FormState {
  name: string
  shortcut: string
  body: string
}

const EMPTY_FORM: FormState = { name: '', shortcut: '', body: '' }

export default function CannedResponsesPage() {
  const [items, setItems] = useState<CannedResponse[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<CannedResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const confirm = useConfirm()

  const load = useCallback(async () => {
    try {
      setItems((await listCannedResponses()).cannedResponses)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load templates')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (editing) {
        await updateCannedResponse(editing.id, form)
        setNotice('Template updated.')
      } else {
        await createCannedResponse(form)
        setNotice('Template created.')
      }
      setForm(EMPTY_FORM)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(item: CannedResponse) {
    setEditing(item)
    setForm({ name: item.name, shortcut: item.shortcut, body: item.body })
    setError(null)
  }

  async function remove(item: CannedResponse) {
    if (!await confirm(`Delete template “${item.name}”?`, { title: 'Delete canned response', confirmLabel: 'Delete', destructive: true })) return
    setError(null)
    try {
      await deleteCannedResponse(item.id)
      if (editing?.id === item.id) {
        setEditing(null)
        setForm(EMPTY_FORM)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  function openNew() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  function openEdit(item: CannedResponse) {
    startEdit(item)
    setShowForm(true)
  }

  return (
    <div className="form-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2 className="channel-form-title">Canned responses</h2>
          <p className="muted">
            Reusable reply templates technicians can insert from the ticket composer.
          </p>
        </div>
        <button className="btn btn-primary btn-sm" onClick={openNew}><Icon name="add" size={14} />New template</button>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Modal open={showForm} onClose={() => { if (!busy) { setShowForm(false); setEditing(null); setForm(EMPTY_FORM) } }} title={editing ? 'Edit template' : 'New template'}>
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <Field label="Name">
              <input
                className="field-input"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                minLength={1}
                maxLength={200}
                required
              />
            </Field>
            <Field label="Shortcut" hint="letters, numbers, . - _ (used in search)">
              <input
                className="field-input mono"
                value={form.shortcut}
                onChange={(e) => setForm({ ...form, shortcut: e.target.value })}
                pattern="[A-Za-z0-9._-]+"
                minLength={1}
                maxLength={40}
                required
              />
            </Field>
          </div>
          <Field label="Body">
            <textarea
              className="field-input"
              rows={5}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              minLength={1}
              maxLength={20000}
              required
            />
          </Field>
          <div className="form-actions">
            <button type="button" className="btn btn-ghost" onClick={() => { setShowForm(false); setEditing(null); setForm(EMPTY_FORM) }} disabled={busy}>
              <Icon name="close" size={14} />Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              <Icon name="save" size={14} />{busy ? 'Saving…' : editing ? 'Save changes' : 'Create template'}
            </button>
          </div>
        </form>
      </Modal>

      <h3 className="channel-title">Templates</h3>
      {items === null ? (
        <span className="etch">Loading templates…</span>
      ) : items.length === 0 ? (
        <div className="muted" style={{ padding: '8px 0' }}>No templates yet.</div>
      ) : (
        <ul className="channel-list">
          {items.map((item) => (
            <li key={item.id} className="channel-card">
              <div className="channel-main">
                <span className="channel-name">{item.name}</span>
                <span className="channel-meta mono">/{item.shortcut}</span>
                <p className="muted" style={{ marginTop: 6 }}>{item.body.slice(0, 140)}{item.body.length > 140 ? '…' : ''}</p>
              </div>
              <div className="channel-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}><Icon name="edit" size={14} />Edit</button>
                <button className="btn btn-ghost btn-sm" onClick={() => void remove(item)}><Icon name="delete" size={14} />Delete</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
