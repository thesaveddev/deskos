import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Modal } from '../components/ui.js'
import { listCalls, logCall, type CallDirection, type CallLog, type CallStatus } from '../lib/telephony.js'

const DIRECTIONS: CallDirection[] = ['inbound', 'outbound', 'internal']
const STATUSES: CallStatus[] = ['ringing', 'answered', 'missed', 'completed', 'failed']

function formatDuration(sec: number): string {
  if (sec <= 0) return '—'
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

interface CallForm {
  direction: CallDirection
  fromNumber: string
  toNumber: string
  callerName: string
  status: CallStatus
  durationSec: string
  ticketId: string
}

const EMPTY_FORM: CallForm = {
  direction: 'inbound', fromNumber: '', toNumber: '', callerName: '', status: 'completed', durationSec: '', ticketId: '',
}

export default function CallsPage() {
  const [calls, setCalls] = useState<CallLog[] | null>(null)
  const [q, setQ] = useState('')
  const [direction, setDirection] = useState<CallDirection | ''>('')
  const [status, setStatus] = useState<CallStatus | ''>('')
  const [form, setForm] = useState<CallForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [logModal, setLogModal] = useState(false)

  const load = useCallback(async () => {
    try {
      setCalls((await listCalls({ q: q || undefined, direction: direction || undefined, status: status || undefined })).calls)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load calls')
    }
  }, [q, direction, status])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250)
    return () => clearTimeout(timer)
  }, [load])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await logCall({
        direction: form.direction,
        fromNumber: form.fromNumber || undefined,
        toNumber: form.toNumber || undefined,
        callerName: form.callerName || undefined,
        status: form.status,
        durationSec: form.durationSec ? Number(form.durationSec) : undefined,
        ticketId: form.ticketId || undefined,
      })
      setForm(EMPTY_FORM)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not log call')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Calls</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div style={{ marginBottom: 16 }}>
        <button className="btn btn-primary btn-sm" onClick={() => setLogModal(true)}>+ Log call</button>
      </div>

      <Modal open={logModal} onClose={() => { if (!busy) setLogModal(false) }} title="Log a call">
        <form onSubmit={(e) => { void submit(e); setLogModal(false) }}>
          <div className="form-row" style={{ marginBottom: '0.75rem' }}>
            <div className="field"><label className="field-label">Direction</label>
              <select className="field-input" value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value as CallDirection })}>
                {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="field"><label className="field-label">Status</label>
              <select className="field-input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as CallStatus })}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row" style={{ marginBottom: '0.75rem' }}>
            <div className="field"><label className="field-label">From</label><input className="field-input mono" placeholder="Number" value={form.fromNumber} onChange={(e) => setForm({ ...form, fromNumber: e.target.value })} /></div>
            <div className="field"><label className="field-label">To</label><input className="field-input mono" placeholder="Number" value={form.toNumber} onChange={(e) => setForm({ ...form, toNumber: e.target.value })} /></div>
          </div>
          <div className="form-row" style={{ marginBottom: '0.75rem' }}>
            <div className="field"><label className="field-label">Caller name</label><input className="field-input" value={form.callerName} onChange={(e) => setForm({ ...form, callerName: e.target.value })} /></div>
            <div className="field"><label className="field-label">Duration (sec)</label><input className="field-input mono" value={form.durationSec} onChange={(e) => setForm({ ...form, durationSec: e.target.value })} /></div>
          </div>
          <div className="field" style={{ marginBottom: '1rem' }}>
            <label className="field-label">Link ticket id (optional)</label>
            <input className="field-input mono" value={form.ticketId} onChange={(e) => setForm({ ...form, ticketId: e.target.value })} />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={() => setLogModal(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Log call'}</button>
          </div>
        </form>
      </Modal>

      <div className="kb-layout">

        <section className="form-panel">
          <div className="kb-toolbar">
            <input className="field-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search numbers or caller…" aria-label="Search calls" />
            <select className="field-input" value={direction} onChange={(e) => setDirection(e.target.value as CallDirection | '')} aria-label="Filter direction">
              <option value="">All directions</option>
              {DIRECTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as CallStatus | '')} aria-label="Filter status">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <h3 className="channel-title">Call log</h3>
          {calls === null ? (
            <span className="etch">Loading calls…</span>
          ) : calls.length === 0 ? (
            <p className="muted">No calls logged.</p>
          ) : (
            <ul className="channel-list">
              {calls.map((c) => (
                <li key={c.id} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name mono">
                      {c.direction === 'inbound' ? (c.from_number || '—') : (c.to_number || '—')}
                      {c.caller_name ? ` · ${c.caller_name}` : ''}
                    </span>
                    <span className="channel-meta mono">
                      {c.direction} · {c.status} · {formatDuration(c.duration_sec)}
                    </span>
                  </div>
                  <div className="channel-actions">
                    {c.ticket_id ? (
                      <Link className="btn btn-ghost btn-sm" to={`/tickets/${c.ticket_id}`}>#{c.ticket_number}</Link>
                    ) : <span className="muted">no ticket</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  )
}
