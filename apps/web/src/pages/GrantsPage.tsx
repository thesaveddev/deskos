import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  approveGrant,
  checkinGrant,
  checkoutGrant,
  denyGrant,
  listGrants,
  requestGrant,
  revokeGrant,
  type Grant,
  type GrantPermission,
  type GrantScope,
  type GrantStatus,
} from '../lib/grants.js'

const PERMISSIONS: GrantPermission[] = ['remote.elevated', 'remote.control', 'remote.attended', 'remote.unattended', 'remote.inspection', 'script.execute']
const SCOPES: GrantScope[] = ['tenant', 'device_group', 'device']

interface RequestForm {
  permission: GrantPermission
  scopeType: GrantScope
  scopeId: string
  reason: string
  expiresAt: string
}

const EMPTY_FORM: RequestForm = { permission: 'remote.elevated', scopeType: 'tenant', scopeId: '', reason: '', expiresAt: '' }

export default function GrantsPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canApprove = perms.has('grant.approve')
  const canRequest = perms.has('grant.request')

  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [status, setStatus] = useState<GrantStatus | ''>('')
  const [mineOnly, setMineOnly] = useState(false)
  const [form, setForm] = useState<RequestForm>(EMPTY_FORM)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setGrants((await listGrants({ status: status || undefined, mine: mineOnly })).grants)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load grants')
    }
  }, [status, mineOnly])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    const iso = form.expiresAt ? new Date(form.expiresAt).toISOString() : ''
    await act(() =>
      requestGrant({
        permission: form.permission,
        scopeType: form.scopeType,
        scopeId: form.scopeType === 'tenant' ? undefined : form.scopeId,
        reason: form.reason,
        expiresAt: iso,
      }),
    )
    setForm(EMPTY_FORM)
    setModalOpen(false)
  }

  return (
    <Shell>
      <PageHeader
        title="Privileged access"
        subtitle="Time-boxed, human-approved elevation. Nothing runs until a grant is checked out."
        actions={canRequest ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}>Request access</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Panel
        title="Grants"
        toolbar={
          <div className="toolbar">
            <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as GrantStatus | '')} aria-label="Filter status">
              <option value="">All statuses</option>
              {['pending', 'approved', 'active', 'denied', 'revoked', 'expired'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <label className="field-input" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
              Mine only
            </label>
          </div>
        }
        empty={grants !== null && grants.length === 0}
      >
        {grants === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading grants…</div>
        ) : (
          <ul className="channel-list">
            {grants.map((g) => (
              <li key={g.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name mono">{g.permission} · {g.scope_type.replace('_', ' ')}</span>
                  <span className="channel-meta mono">
                    {g.grantee_name ?? 'self'} · {g.effective_status} · expires {new Date(g.expires_at).toLocaleString()}
                  </span>
                  {g.reason ? <span className="channel-meta">{g.reason}</span> : null}
                </div>
                <div className="channel-actions">
                  {canApprove && g.status === 'pending' ? (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => approveGrant(g.id))}>Approve</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => denyGrant(g.id))}>Deny</button>
                    </>
                  ) : null}
                  {g.subject_id === auth.user?.id && g.status === 'approved' ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => checkoutGrant(g.id))}>Check out</button>
                  ) : null}
                  {g.subject_id === auth.user?.id && g.status === 'active' ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => checkinGrant(g.id))}>Check in</button>
                  ) : null}
                  {canApprove && !['denied', 'revoked', 'expired'].includes(g.status) ? (
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => revokeGrant(g.id))}>Revoke</button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) setModalOpen(false) }}
        title="Request JIT access"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="grant-form" className="btn btn-primary" disabled={busy || !form.reason.trim() || !form.expiresAt || (form.scopeType !== 'tenant' && !form.scopeId.trim())}>
              {busy ? 'Requesting…' : 'Request'}
            </button>
          </>
        }
      >
        <form id="grant-form" onSubmit={(e) => void submit(e)}>
          <div className="form-row">
            <Field label="Permission">
              <select className="field-input" value={form.permission} onChange={(e) => setForm({ ...form, permission: e.target.value as GrantPermission })}>
                {PERMISSIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Scope">
              <select className="field-input" value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value as GrantScope })}>
                {SCOPES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </Field>
          </div>
          {form.scopeType !== 'tenant' ? (
            <Field label={form.scopeType === 'device' ? 'Device id' : 'Device group id'}>
              <input className="field-input mono" placeholder="uuid" value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} />
            </Field>
          ) : null}
          <Field label="Expires">
            <input className="field-input mono" type="datetime-local" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
          </Field>
          <Field label="Reason" hint="required — who, what, and why">
            <textarea className="field-input" rows={3} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
