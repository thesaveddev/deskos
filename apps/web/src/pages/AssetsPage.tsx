import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  createAsset, createLicence, deleteAsset, deleteLicence, listAssets, listLicences, updateAsset,
  type Asset, type AssetStatus, type AssetType, type Licence,
} from '../lib/assets.js'

const TYPES: AssetType[] = ['hardware', 'mobile', 'network', 'peripheral', 'cloud', 'software', 'other']
const STATUSES: AssetStatus[] = ['in_use', 'available', 'in_repair', 'retired', 'lost']
const STATUS_LABELS: Record<AssetStatus, string> = {
  in_use: 'In use',
  available: 'Available',
  in_repair: 'In repair',
  retired: 'Retired',
  lost: 'Lost',
}

interface AssetForm {
  tag: string
  name: string
  type: AssetType
  status: AssetStatus
  location: string
  supplier: string
  warrantyUntil: string
}

const EMPTY_ASSET: AssetForm = {
  tag: '', name: '', type: 'hardware', status: 'in_use', location: '', supplier: '', warrantyUntil: '',
}

interface LicenceForm {
  name: string
  keyRef: string
  seatsTotal: string
  expiresAt: string
}

const EMPTY_LICENCE: LicenceForm = { name: '', keyRef: '', seatsTotal: '', expiresAt: '' }

export default function AssetsPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('asset.manage')))
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [licences, setLicences] = useState<Licence[]>([])
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<AssetType | ''>('')
  const [statusFilter, setStatusFilter] = useState<AssetStatus | ''>('')
  const [form, setForm] = useState<AssetForm>(EMPTY_ASSET)
  const [editing, setEditing] = useState<Asset | null>(null)
  const [assetOpen, setAssetOpen] = useState(false)
  const [licenceForm, setLicenceForm] = useState<LicenceForm>(EMPTY_LICENCE)
  const [licenceOpen, setLicenceOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([
        listAssets({ q: q || undefined, type: typeFilter || undefined, status: statusFilter || undefined }),
        listLicences(),
      ])
      setAssets(a.assets)
      setLicences(l.licences)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load assets')
    }
  }, [q, typeFilter, statusFilter])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250)
    return () => clearTimeout(timer)
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_ASSET)
    setError(null)
    setAssetOpen(true)
  }

  const openEdit = (asset: Asset) => {
    setEditing(asset)
    setForm({
      tag: asset.tag,
      name: asset.name,
      type: asset.type,
      status: asset.status,
      location: asset.location ?? '',
      supplier: asset.supplier ?? '',
      warrantyUntil: asset.warranty_until ?? '',
    })
    setError(null)
    setAssetOpen(true)
  }

  const openLicence = () => {
    setLicenceForm(EMPTY_LICENCE)
    setError(null)
    setLicenceOpen(true)
  }

  async function handleAssetSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const payload = {
      tag: form.tag,
      name: form.name,
      type: form.type,
      status: form.status,
      location: form.location || undefined,
      supplier: form.supplier || undefined,
      warrantyUntil: form.warrantyUntil || undefined,
    }
    try {
      if (editing) {
        await updateAsset(editing.id, payload)
        setNotice('Asset updated.')
      } else {
        await createAsset(payload)
        setNotice('Asset created.')
      }
      setAssetOpen(false)
      setForm(EMPTY_ASSET)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleLicenceSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || !licenceForm.name.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await createLicence({
        name: licenceForm.name,
        keyRef: licenceForm.keyRef || undefined,
        seatsTotal: licenceForm.seatsTotal ? Number(licenceForm.seatsTotal) : undefined,
        expiresAt: licenceForm.expiresAt || undefined,
      })
      setNotice('Licence created.')
      setLicenceOpen(false)
      setLicenceForm(EMPTY_LICENCE)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Licence creation failed')
    } finally {
      setBusy(false)
    }
  }

  async function removeAsset(asset: Asset) {
    if (!confirm(`Delete asset "${asset.name}"?`)) return
    setError(null)
    try {
      await deleteAsset(asset.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function removeLicence(licence: Licence) {
    if (!confirm(`Delete licence "${licence.name}"?`)) return
    setError(null)
    try {
      await deleteLicence(licence.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const assetName = (id: string | null) => assets?.find((a) => a.id === id)?.name ?? '—'

  return (
    <Shell>
      <PageHeader
        title="Assets"
        subtitle="Hardware, software, and licences across your estate."
        actions={canManage ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={openLicence}>Add licence</button>
            <button className="btn btn-primary btn-sm" onClick={openCreate}>New asset</button>
          </>
        ) : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Panel
        title="Assets"
        toolbar={
          <div className="toolbar">
            <input className="field-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search assets…" aria-label="Search assets" />
            <select className="field-input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as AssetType | '')} aria-label="Filter by type">
              <option value="">All types</option>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="field-input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as AssetStatus | '')} aria-label="Filter by status">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        }
        empty={assets !== null && assets.length === 0}
      >
        {assets === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading assets…</div>
        ) : (
          <ul className="channel-list">
            {assets.map((a) => (
              <li key={a.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{a.name}</span>
                  <span className="channel-meta mono">
                    {a.tag} · {a.type} · {STATUS_LABELS[a.status] ?? a.status}
                    {a.owner_name ? ` · ${a.owner_name}` : ''}
                    {a.device_name ? ` · ${a.device_name}` : ''}
                  </span>
                </div>
                {canManage ? (
                  <div className="channel-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(a)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void removeAsset(a)}>Delete</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div style={{ height: 16 }} />

      <Panel
        title="Licences"
        subtitle={`${licences.length} tracked`}
        empty={licences.length === 0}
      >
        <ul className="channel-list">
          {licences.map((l) => (
            <li key={l.id} className="channel-card">
              <div className="channel-main">
                <span className="channel-name">{l.name}</span>
                <span className="channel-meta mono">
                  {assetName(l.asset_id)} · seats {l.seats_used}/{l.seats_total}
                  {l.expires_at ? ` · expires ${l.expires_at}` : ''}
                </span>
              </div>
              {canManage ? (
                <div className="channel-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void removeLicence(l)}>Delete</button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Panel>

      <Modal
        open={assetOpen}
        onClose={() => { if (!busy) { setAssetOpen(false); setEditing(null); setForm(EMPTY_ASSET) } }}
        title={editing ? 'Edit asset' : 'New asset'}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setAssetOpen(false); setEditing(null); setForm(EMPTY_ASSET) }} disabled={busy}>Cancel</button>
            <button type="submit" form="asset-form" className="btn btn-primary" disabled={busy || !form.tag.trim() || !form.name.trim()}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create asset'}
            </button>
          </>
        }
      >
        <form id="asset-form" onSubmit={(e) => void handleAssetSubmit(e)}>
          <div className="form-row">
            <Field label="Asset tag" hint="unique identifier">
              <input className="field-input mono" value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} minLength={1} maxLength={80} required autoFocus />
            </Field>
            <Field label="Name">
              <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={1} maxLength={200} required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="Type">
              <select className="field-input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as AssetType })}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Status">
              <select className="field-input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as AssetStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Location">
            <input className="field-input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} maxLength={200} />
          </Field>
          <div className="form-row">
            <Field label="Supplier">
              <input className="field-input" value={form.supplier} onChange={(e) => setForm({ ...form, supplier: e.target.value })} maxLength={120} />
            </Field>
            <Field label="Warranty until" hint="YYYY-MM-DD">
              <input className="field-input mono" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} placeholder="2027-01-01" />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={licenceOpen}
        onClose={() => { if (!busy) setLicenceOpen(false) }}
        title="Add licence"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setLicenceOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="licence-form" className="btn btn-primary" disabled={busy || !licenceForm.name.trim()}>Add licence</button>
          </>
        }
      >
        <form id="licence-form" onSubmit={(e) => void handleLicenceSubmit(e)}>
          <Field label="Name">
            <input className="field-input" value={licenceForm.name} onChange={(e) => setLicenceForm({ ...licenceForm, name: e.target.value })} minLength={1} maxLength={200} required autoFocus />
          </Field>
          <div className="form-row">
            <Field label="Key ref">
              <input className="field-input mono" value={licenceForm.keyRef} onChange={(e) => setLicenceForm({ ...licenceForm, keyRef: e.target.value })} maxLength={500} />
            </Field>
            <Field label="Seats total">
              <input className="field-input mono" type="number" min={0} value={licenceForm.seatsTotal} onChange={(e) => setLicenceForm({ ...licenceForm, seatsTotal: e.target.value })} />
            </Field>
          </div>
          <Field label="Expires" hint="YYYY-MM-DD">
            <input className="field-input mono" value={licenceForm.expiresAt} onChange={(e) => setLicenceForm({ ...licenceForm, expiresAt: e.target.value })} placeholder="2027-01-01" />
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
