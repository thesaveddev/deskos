import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
import {
  approvePatch,
  createPatch,
  getPatch,
  listPatches,
  rejectPatch,
  rollbackPatch,
  startPatch,
  submitPatch,
  type PatchDeployment,
  type PatchStatus,
} from '../lib/patches.js'

interface DraftForm {
  name: string
  version: string
  artifactUrl: string
  sha256: string
  channel: 'stable' | 'beta'
  scopeType: 'tenant' | 'device_group'
  scopeId: string
}

const EMPTY_FORM: DraftForm = { name: '', version: '', artifactUrl: '', sha256: '', channel: 'stable', scopeType: 'tenant', scopeId: '' }

const STATUSES: PatchStatus[] = ['draft', 'pending_approval', 'approved', 'rolling_out', 'paused', 'completed', 'rejected', 'rolled_back']
const STATUS_LABELS: Record<PatchStatus, string> = {
  draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved', rolling_out: 'Rolling out',
  paused: 'Paused', completed: 'Completed', rejected: 'Rejected', rolled_back: 'Rolled back',
}
const STATUS_TONES: Record<PatchStatus, string> = {
  draft: 'tone-muted', pending_approval: 'tone-warn', approved: 'tone-info', rolling_out: 'tone-accent',
  paused: 'tone-warn', completed: 'tone-ok', rejected: 'tone-crit', rolled_back: 'tone-crit',
}

function Kpi({ icon, tone, label, value }: { icon: 'download' | 'clock' | 'alert' | 'check'; tone?: string; label: string; value: string | number }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-head">
        <span className={`ops-kpi-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span>
      </div>
      <span className={`ops-kpi-value${tone === 'tone-ok' ? ' tone-ok' : tone === 'tone-crit' ? ' tone-crit' : tone === 'tone-warn' ? ' tone-warn' : ''}`}>{value}</span>
      <span className="ops-kpi-label">{label}</span>
    </div>
  )
}

export default function PatchPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('patch.manage')
  const canApprove = perms.has('patch.approve')

  const [patches, setPatches] = useState<PatchDeployment[] | null>(null)
  const [status, setStatus] = useState<PatchStatus | ''>('')
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ deployment: PatchDeployment; rings: Array<{ ring_index: number; status: string; n: number }> } | null>(null)

  const load = useCallback(async () => {
    try {
      setPatches((await listPatches(status || undefined)).patches)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load patches')
    }
  }, [status])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
      if (detailId) setDetail(await getPatch(detailId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    await act(() =>
      createPatch({
        name: form.name,
        version: form.version,
        artifactUrl: form.artifactUrl,
        sha256: form.sha256,
        channel: form.channel,
        scopeType: form.scopeType,
        scopeId: form.scopeType === 'tenant' ? undefined : form.scopeId,
      }),
    )
    setForm(EMPTY_FORM)
    setModalOpen(false)
  }

  const all = patches ?? []
  const rollingOut = all.filter((p) => p.status === 'rolling_out').length
  const pending = all.filter((p) => p.status === 'pending_approval').length
  const failed = all.reduce((sum, p) => sum + p.failed_count, 0)
  const completed = all.filter((p) => p.status === 'completed').length

  return (
    <Shell>
      <PageHeader
        title="Patch management"
        subtitle="Signed, staged, approval-gated rollouts."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}><Icon name="add" size={14} />New deployment</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="ops-kpi-row">
        <Kpi icon="download" tone="tone-accent" label="Rolling out" value={rollingOut} />
        <Kpi icon="clock" tone="tone-warn" label="Pending approval" value={pending} />
        <Kpi icon="alert" tone="tone-crit" label="Failed devices" value={failed} />
        <Kpi icon="check" tone="tone-ok" label="Completed" value={completed} />
      </div>

      <div className="ops-toolbar">
        <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as PatchStatus | '')} aria-label="Filter status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <span className="spacer" />
        <span className="etch">{all.length} deployment{all.length === 1 ? '' : 's'}</span>
      </div>

      {patches === null ? (
        <div className="etch" style={{ padding: 24 }}>Loading patches…</div>
      ) : patches.length === 0 ? (
        <div className="ops-empty"><strong>No deployments</strong><span>Create a signed patch deployment to get started.</span></div>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>Status</th>
                <th style={{ minWidth: 200 }}>Progress</th>
                <th className="num">Failed</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {patches.map((p) => {
                const pct = p.device_count > 0 ? Math.min(100, (p.succeeded_count / p.device_count) * 100) : 0
                const tone = p.status === 'completed' ? 'ok' : p.failed_count > 0 ? 'warn' : ''
                return (
                  <tr key={p.id}>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        style={{ padding: 0, height: 'auto' }}
                        onClick={() => { setDetailId(p.id); void getPatch(p.id).then(setDetail).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load patch')) }}
                      >
                        <div className="ops-cell-primary">
                          <strong>{p.name} <span className="mono">{p.version}</span></strong>
                          <small>{p.channel} · {p.scope_type === 'device_group' ? 'device group' : 'tenant'}</small>
                        </div>
                      </button>
                    </td>
                    <td><span className={`ops-pill ${STATUS_TONES[p.status]}`}>{STATUS_LABELS[p.status] ?? p.status}</span></td>
                    <td>
                      <div className="ops-progress">
                        <div className="ops-progress-track"><div className={`ops-progress-fill ${tone}`} style={{ width: `${pct}%` }} /></div>
                        <span className="ops-progress-num">{p.succeeded_count}/{p.device_count}</span>
                      </div>
                    </td>
                    <td className="num" style={{ color: p.failed_count > 0 ? 'var(--crit)' : 'var(--text-3)' }}>{p.failed_count}</td>
                    <td>
                      <div className="ops-actions">
                        {p.status === 'draft' && canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => submitPatch(p.id))}>Submit</button> : null}
                        {p.status === 'pending_approval' && canApprove ? (
                          <>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => approvePatch(p.id))}>Approve</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => rejectPatch(p.id))}>Reject</button>
                          </>
                        ) : null}
                        {p.status === 'approved' && canManage ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => startPatch(p.id))}>Start</button> : null}
                        {['rolling_out', 'paused', 'completed'].includes(p.status) && canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => rollbackPatch(p.id))}>Rollback</button> : null}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail ? (
        <>
          <div style={{ height: 16 }} />
          <Panel
            title={`Ring progress — ${detail.deployment.name}`}
            actions={<button className="btn btn-ghost btn-sm" onClick={() => { setDetail(null); setDetailId(null) }}>Close</button>}
            empty={detail.rings.length === 0}
          >
            <div className="ops-table-wrap" style={{ border: 'none', borderRadius: 0 }}>
              <table className="ops-table">
                <thead>
                  <tr><th>Ring</th><th>Status</th><th className="num">Devices</th></tr>
                </thead>
                <tbody>
                  {detail.rings.map((r, i) => (
                    <tr key={i}>
                      <td><span className="mono">Ring {r.ring_index + 1}</span></td>
                      <td><span className="ops-pill tone-info flat">{r.status}</span></td>
                      <td className="num">{r.n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) setModalOpen(false) }}
        title="New deployment"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="patch-form" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.version.trim() || !form.artifactUrl.trim() || !/^[0-9a-fA-F]{64}$/.test(form.sha256)}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </>
        }
      >
        <form id="patch-form" onSubmit={(e) => void submit(e)}>
          <div className="form-row">
            <Field label="Name">
              <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </Field>
            <Field label="Version">
              <input className="field-input mono" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} required />
            </Field>
          </div>
          <Field label="Artifact URL">
            <input className="field-input mono" placeholder="https://…" value={form.artifactUrl} onChange={(e) => setForm({ ...form, artifactUrl: e.target.value })} required />
          </Field>
          <Field label="SHA-256" hint="64 hex characters">
            <input className="field-input mono" placeholder="64 hex" value={form.sha256} onChange={(e) => setForm({ ...form, sha256: e.target.value })} required />
          </Field>
          <div className="form-row">
            <Field label="Channel">
              <select className="field-input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as 'stable' | 'beta' })}>
                <option value="stable">stable</option>
                <option value="beta">beta</option>
              </select>
            </Field>
            <Field label="Scope">
              <select className="field-input" value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value as 'tenant' | 'device_group' })}>
                <option value="tenant">tenant</option>
                <option value="device_group">device group</option>
              </select>
            </Field>
          </div>
          {form.scopeType === 'device_group' ? (
            <Field label="Device group id">
              <input className="field-input mono" placeholder="uuid" value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} />
            </Field>
          ) : null}
        </form>
      </Modal>
    </Shell>
  )
}
