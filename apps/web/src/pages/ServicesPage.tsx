import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { createService, deleteService, listServices, updateService, type Service } from '../lib/catalogue.js'

interface FormState {
  name: string
  description: string
  approvalRequired: boolean
  enabled: boolean
}

const EMPTY_FORM: FormState = { name: '', description: '', approvalRequired: false, enabled: true }

export default function ServicesPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('catalogue.manage')))
  const [items, setItems] = useState<Service[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<Service | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setItems((await listServices()).services)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load services')
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

  const openEdit = (item: Service) => {
    setEditing(item)
    setForm({ name: item.name, description: item.description, approvalRequired: item.approval_required, enabled: item.enabled })
    setError(null)
    setModalOpen(true)
  }

  const closeModal = () => {
    if (busy) return
    setModalOpen(false)
    setEditing(null)
    setForm(EMPTY_FORM)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (editing) {
        await updateService(editing.id, form)
        setNotice('Service updated.')
      } else {
        await createService(form)
        setNotice('Service created.')
      }
      setModalOpen(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: Service) {
    if (!confirm(`Delete service "${item.name}"?`)) return
    setError(null)
    try {
      await deleteService(item.id)
      if (editing?.id === item.id) closeModal()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Service catalogue"
        subtitle="Requestable items with optional approval before fulfilment."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}>New service</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Panel
        title="Catalogue"
        subtitle={`${items?.length ?? 0} service${items?.length === 1 ? '' : 's'}`}
        empty={items !== null && items.length === 0}
      >
        {items === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading services…</div>
        ) : (
          <ul className="channel-list">
            {items.map((s) => (
              <li key={s.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">
                    {s.name} {!s.enabled ? <span className="muted">(disabled)</span> : null}
                  </span>
                  <span className="channel-meta mono">
                    {s.approval_required ? 'approval required' : 'no approval'}
                    {s.category_name ? ` · ${s.category_name}` : ''}
                  </span>
                  {s.description ? <span className="channel-meta">{s.description.slice(0, 160)}{s.description.length > 160 ? '…' : ''}</span> : null}
                </div>
                {canManage ? (
                  <div className="channel-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(s)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void remove(s)}>Delete</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title={editing ? 'Edit service' : 'New service'}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={closeModal} disabled={busy}>Cancel</button>
            <button type="submit" form="service-form" className="btn btn-primary" disabled={busy || !form.name.trim()}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create service'}
            </button>
          </>
        }
      >
        <form id="service-form" onSubmit={(e) => void handleSubmit(e)}>
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={1} maxLength={200} required autoFocus />
          </Field>
          <Field label="Description">
            <textarea className="field-input" rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={20000} />
          </Field>
          <label className="checkbox-field">
            <input type="checkbox" checked={form.approvalRequired} onChange={(e) => setForm({ ...form, approvalRequired: e.target.checked })} />
            <span className="field-label">Requires approval before fulfilment</span>
          </label>
          <label className="checkbox-field">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            <span className="field-label">Enabled (visible to requesters)</span>
          </label>
        </form>
      </Modal>
    </Shell>
  )
}
