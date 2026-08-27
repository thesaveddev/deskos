import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  approveWorkerRun,
  cancelWorkerRun,
  createWorkerRun,
  denyWorkerRun,
  getWorkerRun,
  listWorkerRuns,
  WORKER_RUN_LABELS,
  WORKER_STEP_LABELS,
  type WorkerRun,
  type WorkerRunStatus,
  type WorkerStep,
} from '../lib/ai-worker.js'

const ACTIVE = new Set<WorkerRunStatus>(['queued', 'running', 'waiting_approval', 'waiting_action'])

export default function AiWorkersPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('ai_agent.manage')

  const [runs, setRuns] = useState<WorkerRun[] | null>(null)
  const [status, setStatus] = useState<WorkerRunStatus | ''>('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<WorkerRun | null>(null)
  const [ticketId, setTicketId] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const { runs } = await listWorkerRuns(status || undefined)
      setRuns(runs)
      if (selectedId) {
        const { run } = await getWorkerRun(selectedId)
        setSelected(run)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load worker runs')
    }
  }, [status, selectedId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => {
      void load()
    }, 4000)
    return () => clearInterval(timer)
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

  const startWorker = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || !ticketId.trim()) return
    await act(async () => {
      const { run } = await createWorkerRun(ticketId.trim())
      setSelectedId(run.id)
    })
    setTicketId('')
    setModalOpen(false)
  }

  const anyActive = (runs ?? []).some((r) => ACTIVE.has(r.status))

  return (
    <Shell>
      <PageHeader
        title="AI workers"
        subtitle="AI workers read a ticket, diagnose the linked device, run approved fixes, and notify the requester when it's resolved. Every step is gated and audited."
        actions={
          canManage ? (
            <button className="btn btn-primary btn-sm" onClick={() => { setTicketId(''); setError(null); setModalOpen(true) }}>Run worker on ticket</button>
          ) : undefined
        }
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Panel
        title={anyActive ? 'Worker runs · live' : 'Worker runs'}
        toolbar={
          <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as WorkerRunStatus | '')} aria-label="Filter status">
            <option value="">All statuses</option>
            {Object.entries(WORKER_RUN_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        }
        empty={runs !== null && runs.length === 0}
      >
        {runs === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading worker runs…</div>
        ) : runs.length === 0 ? (
          <div className="etch" style={{ padding: 24 }}>
            No worker runs yet. Start one from a ticket to let the AI worker diagnose and fix it.
          </div>
        ) : (
          <ul className="channel-list">
            {runs.map((r) => (
              <li key={r.id} className="channel-card">
                <button type="button" className="channel-main" style={{ textAlign: 'left', background: 'none', border: 0, cursor: 'pointer', width: '100%' }} onClick={() => setSelectedId(r.id)}>
                  <span className="channel-name mono">
                    {r.ticket_number ? `#${r.ticket_number}` : '—'} · {WORKER_RUN_LABELS[r.status]}
                  </span>
                  <span className="channel-meta">{r.ticket_subject ?? 'Untitled ticket'}</span>
                  <span className="channel-meta mono">{r.device_name ?? 'no device'} · {new Date(r.created_at).toLocaleString()}</span>
                  {r.summary ? <span className="channel-meta">{r.summary}</span> : null}
                </button>
                {canManage && (r.status === 'waiting_approval' || ACTIVE.has(r.status)) ? (
                  <div className="channel-actions">
                    {(r.status === 'waiting_approval') ? (
                      <>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => approveWorkerRun(r.id))}>Approve &amp; continue</button>
                        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => denyWorkerRun(r.id))}>Deny</button>
                      </>
                    ) : null}
                    {ACTIVE.has(r.status) ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void act(() => cancelWorkerRun(r.id))}>Cancel</button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selected ? (
        <Panel title={`Run detail · ${WORKER_RUN_LABELS[selected.status]}`}>
          <div className="worker-run-meta">
            <span className="channel-meta mono">{selected.ticket_number ? `Ticket #${selected.ticket_number}` : 'No ticket'}</span>
            <span className="channel-meta mono">{selected.device_name ?? 'No device'}</span>
            <span className="channel-meta mono">Created {new Date(selected.created_at).toLocaleString()}</span>
            {selected.finished_at ? <span className="channel-meta mono">Finished {new Date(selected.finished_at).toLocaleString()}</span> : null}
          </div>
          {selected.outcome && Object.keys(selected.outcome).length > 0 ? (
            <pre className="mono worker-outcome">{JSON.stringify(selected.outcome, null, 2)}</pre>
          ) : null}
          <ol className="worker-steps">
            {selected.steps.map((step) => <WorkerStepRow key={step.id} step={step} canManage={canManage} busy={busy} onApprove={() => void act(() => approveWorkerRun(selected.id))} onDeny={() => void act(() => denyWorkerRun(selected.id))} />)}
          </ol>
        </Panel>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) setModalOpen(false) }}
        title="Run an AI worker on a ticket"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="worker-form" className="btn btn-primary" disabled={busy || !ticketId.trim()}>
              {busy ? 'Starting…' : 'Run worker'}
            </button>
          </>
        }
      >
        <form id="worker-form" onSubmit={(e) => void startWorker(e)}>
          <Field label="Ticket id" hint="The worker will read the ticket, diagnose the linked device, and propose fixes. Device fixes run on the endpoint agent.">
            <input
              className="field-input mono"
              placeholder="ticket uuid"
              value={ticketId}
              onChange={(e) => setTicketId(e.target.value)}
            />
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}

function WorkerStepRow({ step, canManage, busy, onApprove, onDeny }: { step: WorkerStep; canManage: boolean; busy: boolean; onApprove: () => void; onDeny: () => void }) {
  const isApproval = step.status === 'awaiting_approval'
  return (
    <li className={`worker-step worker-step-${step.status}`}>
      <div className="worker-step-head">
        <span className="channel-name mono">{step.tool}</span>
        <span className={`pill pill-${step.risk}`}>{step.risk === 'high' ? 'high risk' : step.risk}</span>
        <span className="channel-meta mono">{WORKER_STEP_LABELS[step.status]}</span>
      </div>
      {step.rationale ? <div className="channel-meta">{step.rationale}</div> : null}
      {step.error ? <div className="worker-step-error mono">{step.error}</div> : null}
      {step.result && Object.keys(step.result).length > 0 ? (
        <pre className="mono worker-step-result">{JSON.stringify(step.result, null, 2).slice(0, 2000)}</pre>
      ) : null}
      {isApproval && canManage ? (
        <div className="worker-step-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onApprove}>Approve &amp; run</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onDeny}>Deny</button>
        </div>
      ) : null}
    </li>
  )
}