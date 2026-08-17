import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  approveRemediation,
  denyRemediation,
  listRemediations,
  proposeRemediation,
  type Remediation,
  type RemediationSourceType,
  type RemediationStatus,
} from '../lib/ai-agent.js'

const SOURCES: RemediationSourceType[] = ['device_alert', 'posture_alert', 'dex', 'ticket']
const KINDS = ['high_cpu', 'high_mem', 'low_disk', 'offline']

interface SignalForm {
  sourceType: RemediationSourceType
  kind: string
  deviceId: string
  ticketId: string
}

const EMPTY_FORM: SignalForm = { sourceType: 'device_alert', kind: 'high_cpu', deviceId: '', ticketId: '' }

export default function AiAgentPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('ai_agent.manage')

  const [remediations, setRemediations] = useState<Remediation[] | null>(null)
  const [status, setStatus] = useState<RemediationStatus | ''>('')
  const [form, setForm] = useState<SignalForm>(EMPTY_FORM)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRemediations((await listRemediations(status || undefined)).remediations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load remediations')
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
      proposeRemediation({
        sourceType: form.sourceType,
        deviceId: form.deviceId.trim() || undefined,
        kind: form.kind.trim() || undefined,
        ticketId: form.sourceType === 'ticket' ? form.ticketId.trim() || undefined : undefined,
      }),
    )
    setForm(EMPTY_FORM)
    setModalOpen(false)
  }

  return (
    <Shell>
      <PageHeader
        title="AI Level-1 agent"
        subtitle="The agent proposes bounded remediations from a fixed tool catalog — nothing executes until a human approves it."
        actions={<button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}>Propose remediation</button>}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Panel
        title="Remediation queue"
        toolbar={
          <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as RemediationStatus | '')} aria-label="Filter status">
            <option value="">All statuses</option>
            {['proposed', 'approved', 'executed', 'denied', 'failed', 'skipped'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        }
        empty={remediations !== null && remediations.length === 0}
      >
        {remediations === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading remediations…</div>
        ) : (
          <ul className="channel-list">
            {remediations.map((r) => (
              <li key={r.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name mono">{r.tool} · {r.status}</span>
                  <span className="channel-meta mono">
                    {r.source_type.replace('_', ' ')}{r.device_name ? ` · ${r.device_name}` : ''} · {new Date(r.created_at).toLocaleString()}
                  </span>
                  {r.rationale ? <span className="channel-meta">{r.rationale}</span> : null}
                </div>
                <div className="channel-actions">
                  {canManage && r.status === 'proposed' ? (
                    <>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => approveRemediation(r.id))}>Approve &amp; run</button>
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => denyRemediation(r.id))}>Deny</button>
                    </>
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
        title="Propose a remediation"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="remediation-form" className="btn btn-primary" disabled={busy || (form.sourceType === 'ticket' ? !form.ticketId.trim() : !form.deviceId.trim())}>
              {busy ? 'Proposing…' : 'Propose'}
            </button>
          </>
        }
      >
        <form id="remediation-form" onSubmit={(e) => void submit(e)}>
          <div className="form-row">
            <Field label="Source type">
              <select className="field-input" value={form.sourceType} onChange={(e) => setForm({ ...form, sourceType: e.target.value as RemediationSourceType })}>
                {SOURCES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </Field>
            {form.sourceType !== 'ticket' ? (
              <Field label="Signal kind">
                <select className="field-input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
                </select>
              </Field>
            ) : null}
          </div>
          <Field label={form.sourceType === 'ticket' ? 'Ticket id' : 'Device id'}>
            <input
              className="field-input mono"
              placeholder="uuid"
              value={form.sourceType === 'ticket' ? form.ticketId : form.deviceId}
              onChange={(e) => setForm(form.sourceType === 'ticket' ? { ...form, ticketId: e.target.value } : { ...form, deviceId: e.target.value })}
            />
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
