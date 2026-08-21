import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, useConfirm } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
import { createService, deleteService, listServices, updateService, type Service } from '../lib/catalogue.js'

interface FormState {
  name: string
  description: string
  approvalRequired: boolean
  enabled: boolean
}

const EMPTY_FORM: FormState = { name: '', description: '', approvalRequired: false, enabled: true }

function Kpi({ icon, tone, label, value }: { icon: 'layers' | 'check' | 'shield'; tone?: string; label: string; value: string | number }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-head">
        <span className={`ops-kpi-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span>
      </div>
      <span className={`ops-kpi-value${tone === 'tone-ok' ? ' tone-ok' : tone === 'tone-warn' ? ' tone-warn' : ''}`}>{value}</span>
      <span className="ops-kpi-label">{label}</span>
    </div>
  )
}

export default function ServicesPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('catalogue.manage')))
  const confirm = useConfirm()
  const [items, setItems] = useState<Service[] | null>(null)
  const [q, setQ] = useState('')
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
    if (!await confirm(`Delete service “${item.name}”?`, { title: 'Delete service', confirmLabel: 'Delete', destructive: true })) return
    setError(null)
    try {
      await deleteService(item.id)
      if (editing?.id === item.id) closeModal()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const filtered = (items ?? []).filter((s) => !q.trim() || s.name.toLowerCase().includes(q.toLowerCase()) || s.description.toLowerCase().includes(q.toLowerCase()))
  const enabledCount = (items ?? []).filter((s) => s.enabled).length
  const approvalCount = (items ?? []).filter((s) => s.approval_required).length

  return (
    <Shell>
      <PageHeader
        title="Service catalogue"
        subtitle="Requestable items with optional approval before fulfilment."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />New service</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="ops-kpi-row">
        <Kpi icon="layers" label="Total services" value={items?.length ?? '—'} />
        <Kpi icon="check" tone="tone-ok" label="Enabled" value={enabledCount} />
        <Kpi icon="shield" tone="tone-warn" label="Approval required" value={approvalCount} />
      </div>

      <div className="ops-toolbar">
        <input className="field-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search services…" aria-label="Search services" />
        <span className="spacer" />
        <span className="etch">{filtered.length} of {items?.length ?? 0} services</span>
      </div>

      {items === null ? (
        <div className="etch" style={{ padding: 24 }}>Loading services…</div>
      ) : filtered.length === 0 ? (
        <div className="ops-empty"><strong>No services found</strong><span>Create a service so your team can request it.</span></div>
      ) : (
        <div className="ops-card-grid">
          {filtered.map((s) => (
            <div key={s.id} className="ops-card">
              <div className="ops-card-head">
                <span className="ops-card-icon"><Icon name="server" size={17} /></span>
                <div className="ops-card-title">
                  <strong>{s.name}</strong>
                  <small>{s.category_name ?? 'Uncategorised'}</small>
                </div>
              </div>
              <p className="ops-card-desc">{s.description ? (s.description.length > 160 ? `${s.description.slice(0, 160)}…` : s.description) : 'No description provided.'}</p>
              <div className="ops-card-foot">
                <div className="ops-badges">
                  {s.enabled ? (
                    <span className="ops-pill tone-ok">Active</span>
                  ) : (
                    <span className="ops-pill tone-muted flat">Disabled</span>
                  )}
                  {s.approval_required ? (
                    <span className="ops-pill tone-warn">Approval required</span>
                  ) : (
                    <span className="ops-pill tone-info flat">Auto-fulfil</span>
                  )}
                </div>
                {canManage ? (
                  <div className="ops-actions">
                    <button className="btn btn-ghost btn-sm" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => openEdit(s)}><Icon name="edit" size={14} /></button>
                    <button className="btn btn-ghost btn-sm" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}><Icon name="delete" size={14} /></button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}

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
