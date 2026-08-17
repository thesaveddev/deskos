import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
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

  return (
    <Shell>
      <PageHeader
        title="Patch management"
        subtitle="Signed, staged, approval-gated rollouts."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}>New deployment</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Panel
        title="Deployments"
        toolbar={
          <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as PatchStatus | '')} aria-label="Filter status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        }
        empty={patches !== null && patches.length === 0}
      >
        {patches === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading patches…</div>
        ) : (
          <ul className="channel-list">
            {patches.map((p) => (
              <li key={p.id} className="channel-card">
                <div className="channel-main">
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    style={{ alignSelf: 'flex-start', padding: 0, height: 'auto' }}
                    onClick={() => { setDetailId(p.id); void getPatch(p.id).then(setDetail).catch((e) => setError(e instanceof Error ? e.message : 'Failed to load patch')) }}
                  >
                    {p.name} <span className="mono">{p.version}</span>
                  </button>
                  <span className="channel-meta mono">
                    {p.channel} · {p.status} · {p.succeeded_count}/{p.device_count} ok · {p.failed_count} failed
                  </span>
                </div>
                <div className="channel-actions">
                  {p.status === 'draft' && canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => submitPatch(p.id))}>Submit</button> : null}
                  {p.status === 'pending_approval' && canApprove ? (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => approvePatch(p.id))}>Approve</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => rejectPatch(p.id))}>Reject</button>
                    </>
                  ) : null}
                  {p.status === 'approved' && canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => startPatch(p.id))}>Start</button> : null}
                  {['rolling_out', 'paused', 'completed'].includes(p.status) && canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => rollbackPatch(p.id))}>Rollback</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {detail ? (
        <>
          <div style={{ height: 16 }} />
          <Panel
            title={`Ring progress — ${detail.deployment.name}`}
            actions={<button className="btn btn-ghost btn-sm" onClick={() => { setDetail(null); setDetailId(null) }}>Close</button>}
            empty={detail.rings.length === 0}
          >
            <ul className="channel-list">
              {detail.rings.map((r, i) => (
                <li key={i} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name mono">Ring {r.ring_index + 1}</span>
                    <span className="channel-meta mono">{r.status} · {r.n} devices</span>
                  </div>
                </li>
              ))}
            </ul>
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
