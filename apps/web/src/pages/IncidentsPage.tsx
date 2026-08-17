import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  bridgeIncident,
  declareIncident,
  getIncident,
  listIncidents,
  updateIncident,
  type IncidentLink,
  type IncidentSeverity,
  type IncidentStatus,
  type MajorIncident,
} from '../lib/incidents.js'

const SEVERITIES: IncidentSeverity[] = ['sev1', 'sev2', 'sev3', 'sev4', 'sev5']
const STATUSES: IncidentStatus[] = ['open', 'investigating', 'identified', 'mitigated', 'resolved', 'closed']

function severityLabel(s: IncidentSeverity): string {
  return s.toUpperCase()
}

interface DeclareForm {
  subject: string
  description: string
  severity: IncidentSeverity
}

const EMPTY_FORM: DeclareForm = { subject: '', description: '', severity: 'sev3' }

export default function IncidentsPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('incident.manage')))
  const [incidents, setIncidents] = useState<MajorIncident[] | null>(null)
  const [status, setStatus] = useState<IncidentStatus | ''>('')
  const [severity, setSeverity] = useState<IncidentSeverity | ''>('')
  const [form, setForm] = useState<DeclareForm>(EMPTY_FORM)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ incident: MajorIncident; links: IncidentLink[] } | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [bridgeTarget, setBridgeTarget] = useState('')

  const load = useCallback(async () => {
    try {
      setIncidents((await listIncidents({ status: status || undefined, severity: severity || undefined })).incidents)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load incidents')
    }
  }, [status, severity])

  useEffect(() => {
    void load()
  }, [load])

  const loadDetail = useCallback(async (id: string) => {
    setDetailBusy(true)
    setDetail(null)
    try {
      setDetail(await getIncident(id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load incident')
    } finally {
      setDetailBusy(false)
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await declareIncident({ subject: form.subject, description: form.description || undefined, severity: form.severity })
      setForm(EMPTY_FORM)
      setModalOpen(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not declare incident')
    } finally {
      setBusy(false)
    }
  }

  const patch = async (id: string, body: { status?: IncidentStatus; severity?: IncidentSeverity }) => {
    setDetailBusy(true)
    setError(null)
    try {
      await updateIncident(id, body)
      await load()
      await loadDetail(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update incident')
    } finally {
      setDetailBusy(false)
    }
  }

  const bridge = async (id: string) => {
    if (!bridgeTarget.trim()) return
    setDetailBusy(true)
    setError(null)
    try {
      await bridgeIncident(id, bridgeTarget.trim())
      setBridgeTarget('')
      await loadDetail(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not bridge ticket')
    } finally {
      setDetailBusy(false)
    }
  }

  const select = (id: string) => {
    setSelectedId(id)
    void loadDetail(id)
  }

  return (
    <Shell>
      <PageHeader
        title="Major incidents"
        subtitle="Severity-first command centre for Sev1–Sev5 events."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}>Declare incident</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <Panel
        title="Command centre"
        toolbar={
          <div className="toolbar">
            <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | '')} aria-label="Filter status">
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="field-input" value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity | '')} aria-label="Filter severity">
              <option value="">All severities</option>
              {SEVERITIES.map((s) => <option key={s} value={s}>{severityLabel(s)}</option>)}
            </select>
          </div>
        }
        empty={incidents !== null && incidents.length === 0}
      >
        {incidents === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading incidents…</div>
        ) : (
          <ul className="channel-list">
            {incidents.map((inc) => (
              <li key={inc.id} className="channel-card">
                <div className="channel-main">
                  <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', padding: 0, height: 'auto' }} onClick={() => select(inc.id)}>
                    #{inc.number} · {inc.subject}
                  </button>
                  <span className="channel-meta mono">
                    {severityLabel(inc.severity)} · {inc.status}
                    {inc.commander_name ? ` · ${inc.commander_name}` : ''}
                  </span>
                </div>
                <div className="channel-actions">
                  <Link className="btn btn-ghost btn-sm" to={`/tickets/${inc.ticket_id}`}>Ticket</Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {selectedId ? (
        <>
          <div style={{ height: 16 }} />
          <Panel
            title="Incident detail"
            actions={<button className="btn btn-ghost btn-sm" onClick={() => { setSelectedId(null); setDetail(null) }}>Close</button>}
          >
            {detailBusy && !detail ? (
              <div className="etch" style={{ padding: 24 }}>Loading…</div>
            ) : detail ? (
              <div style={{ padding: 16 }}>
                <div className="toolbar" style={{ marginBottom: 12 }}>
                  {canManage ? (
                    <>
                      <select className="field-input" value={detail.incident.status} onChange={(e) => void patch(selectedId, { status: e.target.value as IncidentStatus })} aria-label="Status">
                        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                      <select className="field-input" value={detail.incident.severity} onChange={(e) => void patch(selectedId, { severity: e.target.value as IncidentSeverity })} aria-label="Severity">
                        {SEVERITIES.map((s) => <option key={s} value={s}>{severityLabel(s)}</option>)}
                      </select>
                    </>
                  ) : (
                    <span className="channel-meta mono">{detail.incident.status} · {severityLabel(detail.incident.severity)}</span>
                  )}
                </div>
                <p className="muted" style={{ marginBottom: 16 }}>
                  Commander: {detail.incident.commander_name ?? 'unassigned'} · Priority: {detail.incident.priority}
                </p>

                <h3 className="channel-title">Bridged tickets</h3>
                {detail.links.length === 0 ? (
                  <p className="muted">No linked tickets.</p>
                ) : (
                  <ul className="channel-list">
                    {detail.links.map((link) => (
                      <li key={link.id} className="channel-card">
                        <div className="channel-main">
                          <span className="channel-name mono">#{link.target_number} · {link.target_subject}</span>
                          <span className="channel-meta mono">{link.target_status} · {link.target_priority}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {canManage ? (
                  <div className="form-row" style={{ marginTop: 16 }}>
                    <input className="field-input mono" placeholder="Bridge a ticket by id (uuid)" value={bridgeTarget} onChange={(e) => setBridgeTarget(e.target.value)} />
                    <button type="button" className="btn btn-ghost" disabled={!bridgeTarget.trim() || detailBusy} onClick={() => void bridge(selectedId)}>Bridge</button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Panel>
        </>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) setModalOpen(false) }}
        title="Declare incident"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="incident-form" className="btn btn-primary" disabled={busy || !form.subject.trim()}>
              {busy ? 'Declaring…' : 'Declare'}
            </button>
          </>
        }
      >
        <form id="incident-form" onSubmit={(e) => void submit(e)}>
          <Field label="Subject">
            <input className="field-input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} required autoFocus />
          </Field>
          <Field label="Initial description">
            <textarea className="field-input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Severity">
            <select className="field-input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as IncidentSeverity })}>
              {SEVERITIES.map((s) => <option key={s} value={s}>{severityLabel(s)}</option>)}
            </select>
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
