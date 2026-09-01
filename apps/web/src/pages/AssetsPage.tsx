import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, useConfirm } from '../components/ui.js'
import { MfaQrCode } from '../components/MfaQrCode.js'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icons.js'
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
const STATUS_TONES: Record<AssetStatus, string> = {
  in_use: 'tone-info',
  available: 'tone-ok',
  in_repair: 'tone-warn',
  retired: 'tone-muted',
  lost: 'tone-crit',
}

interface AssetForm {
  tag: string
  name: string
  type: AssetType
  status: AssetStatus
  location: string
  supplier: string
  warrantyUntil: string
  ownerId: string
  deviceId: string
}

const EMPTY_ASSET: AssetForm = {
  tag: '', name: '', type: 'hardware', status: 'in_use', location: '', supplier: '', warrantyUntil: '', ownerId: '', deviceId: '',
}

interface LicenceForm {
  name: string
  keyRef: string
  seatsTotal: string
  expiresAt: string
}

const EMPTY_LICENCE: LicenceForm = { name: '', keyRef: '', seatsTotal: '', expiresAt: '' }

function Kpi({ icon, tone, label, value, sub }: { icon: 'package' | 'monitor' | 'box' | 'wrench' | 'key'; tone?: string; label: string; value: string | number; sub?: string }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-head">
        <span className={`ops-kpi-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span>
      </div>
      <span className={`ops-kpi-value${tone === 'tone-ok' ? ' tone-ok' : tone === 'tone-warn' ? ' tone-warn' : tone === 'tone-crit' ? ' tone-crit' : ''}`}>{value}</span>
      <span className="ops-kpi-label">{label}</span>
      {sub ? <span className="ops-kpi-sub">{sub}</span> : null}
    </div>
  )
}

export default function AssetsPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('asset.manage')))
  const confirm = useConfirm()
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [licences, setLicences] = useState<Licence[]>([])
  const [tab, setTab] = useState<'assets' | 'licences'>('assets')
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
  const [qrAsset, setQrAsset] = useState<Asset | null>(null)
  const [deviceOptions, setDeviceOptions] = useState<Array<{ id: string; name: string; hostname: string }>>([])
  const [memberOptions, setMemberOptions] = useState<Array<{ id: string; name: string; email: string }>>([])

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

  useEffect(() => {
    if (!canManage) return
    void Promise.all([
      api<{ devices: Array<{ id: string; name: string; hostname: string }> }>('/devices?limit=200'),
      api<{ members: Array<{ user_id: string; name: string | null; email: string }> }>('/members?status=active'),
    ]).then(([devices, members]) => {
      setDeviceOptions(devices.devices)
      setMemberOptions(members.members.map((member) => ({ id: member.user_id, name: member.name || member.email, email: member.email })))
    }).catch(() => { setDeviceOptions([]); setMemberOptions([]) })
  }, [canManage])

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
      ownerId: asset.owner_id ?? '',
      deviceId: asset.device_id ?? '',
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
      ownerId: editing ? (form.ownerId || null) : undefined,
      deviceId: editing ? (form.deviceId || null) : undefined,
    }
    try {
      if (editing) {
        await updateAsset(editing.id, payload)
        setNotice('Asset updated.')
      } else {
        await createAsset({ ...payload, ownerId: form.ownerId || undefined, deviceId: form.deviceId || undefined })
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
    if (!await confirm(`Delete asset “${asset.name}”?`, { title: 'Delete asset', confirmLabel: 'Delete', destructive: true })) return
    setError(null)
    try {
      await deleteAsset(asset.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  async function removeLicence(licence: Licence) {
    if (!await confirm(`Delete licence “${licence.name}”?`, { title: 'Delete licence', confirmLabel: 'Delete', destructive: true })) return
    setError(null)
    try {
      await deleteLicence(licence.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const assetName = (id: string | null) => assets?.find((a) => a.id === id)?.name ?? '—'
  const count = (s: AssetStatus) => (assets ?? []).filter((a) => a.status === s).length
  const assigneeLabel = (a: Asset) => a.assigned_user_name ?? (a.assignment_status === 'shared' ? 'Shared pool' : a.owner_name ?? '—')

  return (
    <Shell>
      <PageHeader
        title="Assets"
        subtitle="Hardware, software, and licences across your estate."
        actions={canManage ? (
          <>
            <button className="btn btn-ghost btn-sm" onClick={openLicence}><Icon name="add" size={14} />Add licence</button>
            <button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />New asset</button>
          </>
        ) : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="ops-kpi-row">
        <Kpi icon="package" label="Total assets" value={assets?.length ?? '—'} sub={`${licences.length} licences tracked`} />
        <Kpi icon="monitor" tone="tone-info" label="In use" value={count('in_use')} />
        <Kpi icon="box" tone="tone-ok" label="Available" value={count('available')} />
        <Kpi icon="wrench" tone="tone-warn" label="In repair" value={count('in_repair')} sub={`${count('retired')} retired · ${count('lost')} lost`} />
        <Kpi icon="key" label="Assigned" value={(assets ?? []).filter((a) => a.assignment_status === 'assigned' || a.assignment_status === 'temporary').length} sub="To staff members" />
      </div>

      <div className="tabs">
        <button type="button" className={`tab ${tab === 'assets' ? 'active' : ''}`} onClick={() => setTab('assets')}>
          Assets {assets ? <span className="tab-count">{assets.length}</span> : null}
        </button>
        <button type="button" className={`tab ${tab === 'licences' ? 'active' : ''}`} onClick={() => setTab('licences')}>
          Licences <span className="tab-count">{licences.length}</span>
        </button>
      </div>

      {tab === 'assets' ? (
        <>
          <div className="ops-toolbar">
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

          {assets === null ? (
            <div className="etch" style={{ padding: 24 }}>Loading assets…</div>
          ) : assets.length === 0 ? (
            <div className="ops-empty"><strong>No assets match</strong><span>Adjust your search or add a new asset.</span></div>
          ) : (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Tag</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Assigned to</th>
                    <th>Location</th>
                    <th>Warranty</th>
                    {canManage ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {assets.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <div className="ops-cell-primary">
                          <strong>{a.name}</strong>
                          {a.device_name ? <small>{a.device_name}</small> : null}
                        </div>
                      </td>
                      <td><span className="mono muted">{a.tag}</span></td>
                      <td><span className="mono muted">{a.type}</span></td>
                      <td><span className={`ops-pill ${STATUS_TONES[a.status] ?? 'tone-muted'}`}>{STATUS_LABELS[a.status] ?? a.status}</span></td>
                      <td>{assigneeLabel(a)}</td>
                      <td className="muted">{a.location ?? '—'}</td>
                      <td className="mono muted">{a.warranty_until ?? '—'}</td>
                      {canManage ? (
                        <td>
                          <div className="ops-actions">
                            {a.qr_payload ? (
                              <button className="btn btn-ghost btn-sm" title="Asset label" aria-label="View asset label" onClick={() => setQrAsset(a)}><Icon name="eye" size={14} /></button>
                            ) : null}
                            <button className="btn btn-ghost btn-sm" title="Edit" aria-label="Edit asset" onClick={() => openEdit(a)}><Icon name="edit" size={14} /></button>
                            <button className="btn btn-ghost btn-sm" title="Delete" aria-label="Delete asset" onClick={() => void removeAsset(a)}><Icon name="delete" size={14} /></button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : licences.length === 0 ? (
        <div className="ops-empty"><strong>No licences yet</strong><span>Track software entitlements and seat usage here.</span></div>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Licence</th>
                <th>Linked asset</th>
                <th style={{ minWidth: 220 }}>Seat usage</th>
                <th>Expires</th>
                {canManage ? <th style={{ textAlign: 'right' }}>Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {licences.map((l) => {
                const pct = l.seats_total > 0 ? Math.min(100, (l.seats_used / l.seats_total) * 100) : 0
                const tone = pct >= 95 ? 'crit' : pct >= 75 ? 'warn' : 'ok'
                return (
                  <tr key={l.id}>
                    <td>
                      <div className="ops-cell-primary">
                        <strong>{l.name}</strong>
                        {l.key_ref ? <small>{l.key_ref}</small> : null}
                      </div>
                    </td>
                    <td className="muted">{assetName(l.asset_id)}</td>
                    <td>
                      <div className="ops-progress">
                        <div className="ops-progress-track"><div className={`ops-progress-fill ${tone}`} style={{ width: `${pct}%` }} /></div>
                        <span className="ops-progress-num">{l.seats_used}/{l.seats_total}</span>
                      </div>
                    </td>
                    <td className="mono muted">{l.expires_at ?? '—'}</td>
                    {canManage ? (
                      <td>
                        <div className="ops-actions">
                          <button className="btn btn-ghost btn-sm" title="Delete" aria-label="Delete licence" onClick={() => void removeLicence(l)}><Icon name="delete" size={14} /></button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={assetOpen}
        onClose={() => { if (!busy) { setAssetOpen(false); setEditing(null); setForm(EMPTY_ASSET) } }}
        title={editing ? 'Edit asset' : 'New asset'}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setAssetOpen(false); setEditing(null); setForm(EMPTY_ASSET) }} disabled={busy}>Cancel</button>
            <button type="submit" form="asset-form" className="btn btn-primary" disabled={busy || !form.tag.trim() || !form.name.trim()}>
              <Icon name="save" size={14} />{busy ? 'Saving…' : editing ? 'Save changes' : 'Create asset'}
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
          <div className="form-row">
            <Field label="Primary owner" hint="Optional IT owner">
              <select className="field-input" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}><option value="">No owner</option>{memberOptions.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}</select>
            </Field>
            <Field label="Linked endpoint" hint="Optional enrolled device">
              <select className="field-input" value={form.deviceId} onChange={(e) => setForm({ ...form, deviceId: e.target.value })}><option value="">No device link</option>{deviceOptions.map((device) => <option key={device.id} value={device.id}>{device.name}{device.hostname ? ` · ${device.hostname}` : ''}</option>)}</select>
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

      <Modal open={Boolean(qrAsset)} onClose={() => setQrAsset(null)} title={qrAsset ? `Asset label · ${qrAsset.tag}` : 'Asset label'} width={360}>
        {qrAsset ? <div className="asset-label-preview"><MfaQrCode value={qrAsset.qr_payload ?? `reydesk://asset/${qrAsset.id}/${qrAsset.tag}`} /><strong className="mono">{qrAsset.tag}</strong><span>{qrAsset.name}</span><small>Scan to identify this asset in ReyDesk.</small></div> : null}
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
