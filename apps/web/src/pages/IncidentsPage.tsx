import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
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

const SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  sev1: 'Sev 1 · Critical', sev2: 'Sev 2 · Major', sev3: 'Sev 3 · Significant', sev4: 'Sev 4 · Minor', sev5: 'Sev 5 · Advisory',
}
const SEVERITY_SHORT: Record<IncidentSeverity, string> = { sev1: 'Sev 1', sev2: 'Sev 2', sev3: 'Sev 3', sev4: 'Sev 4', sev5: 'Sev 5' }
const SEVERITY_TONES: Record<IncidentSeverity, string> = {
  sev1: 'tone-crit', sev2: 'tone-crit', sev3: 'tone-warn', sev4: 'tone-info', sev5: 'tone-muted',
}
const STATUS_TONES: Record<IncidentStatus, string> = {
  open: 'tone-crit', investigating: 'tone-warn', identified: 'tone-warn', mitigated: 'tone-info', resolved: 'tone-ok', closed: 'tone-muted',
}
const STATUS_LABELS: Record<IncidentStatus, string> = {
  open: 'Open', investigating: 'Investigating', identified: 'Identified', mitigated: 'Mitigated', resolved: 'Resolved', closed: 'Closed',
}

function severityLabel(s: IncidentSeverity): string {
  return s.toUpperCase()
}

function Kpi({ icon, tone, label, value, sub }: { icon: 'flag' | 'alert' | 'check'; tone?: string; label: string; value: string | number; sub?: string }) {
  return (
    <div className="ops-kpi">
      <div className="ops-kpi-head">
        <span className={`ops-kpi-icon${tone ? ` ${tone}` : ''}`}><Icon name={icon} size={16} /></span>
      </div>
      <span className={`ops-kpi-value${tone === 'tone-ok' ? ' tone-ok' : tone === 'tone-crit' ? ' tone-crit' : tone === 'tone-warn' ? ' tone-warn' : ''}`}>{value}</span>
      <span className="ops-kpi-label">{label}</span>
      {sub ? <span className="ops-kpi-sub">{sub}</span> : null}
    </div>
  )
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

  const all = incidents ?? []
  const active = all.filter((i) => ['open', 'investigating', 'identified', 'mitigated'].includes(i.status))
  const sev1 = all.filter((i) => i.severity === 'sev1')
  const sev2 = all.filter((i) => i.severity === 'sev2')
  const resolved = all.filter((i) => ['resolved', 'closed'].includes(i.status))

  return (
    <Shell>
      <PageHeader
        title="Major incidents"
        subtitle="Severity-first command centre for Sev1–Sev5 events."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}><Icon name="flag" size={14} />Declare incident</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="ops-kpi-row">
        <Kpi icon="flag" tone="tone-crit" label="Active incidents" value={active.length} sub={`${resolved.length} resolved`} />
        <Kpi icon="alert" tone="tone-crit" label="Sev 1" value={sev1.length} />
        <Kpi icon="alert" tone="tone-warn" label="Sev 2" value={sev2.length} />
        <Kpi icon="check" tone="tone-ok" label="Resolved / closed" value={resolved.length} />
      </div>

      <div className="ops-toolbar">
        <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus | '')} aria-label="Filter status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        <select className="field-input" value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity | '')} aria-label="Filter severity">
          <option value="">All severities</option>
          {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_SHORT[s]}</option>)}
        </select>
        <span className="spacer" />
        <span className="etch">{all.length} incident{all.length === 1 ? '' : 's'}</span>
      </div>

      {incidents === null ? (
        <div className="etch" style={{ padding: 24 }}>Loading incidents…</div>
      ) : incidents.length === 0 ? (
        <div className="ops-empty"><strong>No incidents</strong><span>Declare an incident to open the command centre.</span></div>
      ) : (
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Severity</th>
                <th>Incident</th>
                <th>Status</th>
                <th>Commander</th>
                <th style={{ textAlign: 'right' }}>Ticket</th>
              </tr>
            </thead>
            <tbody>
              {incidents.map((inc) => (
                <tr key={inc.id}>
                  <td><span className={`ops-pill ${SEVERITY_TONES[inc.severity]}`}>{SEVERITY_SHORT[inc.severity]}</span></td>
                  <td>
                    <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, height: 'auto' }} onClick={() => select(inc.id)}>
                      <div className="ops-cell-primary">
                        <strong>#{inc.number} · {inc.subject}</strong>
                        <small>Priority {inc.priority}</small>
                      </div>
                    </button>
                  </td>
                  <td><span className={`ops-pill ${STATUS_TONES[inc.status]}`}>{STATUS_LABELS[inc.status] ?? inc.status}</span></td>
                  <td className="muted">{inc.commander_name ?? 'Unassigned'}</td>
                  <td>
                    <div className="ops-actions">
                      <Link className="btn btn-ghost btn-sm" to={`/tickets/${inc.ticket_id}`}>View ticket</Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
                <div className="ops-badges" style={{ marginBottom: 14 }}>
                  <span className={`ops-pill ${SEVERITY_TONES[detail.incident.severity]}`}>{SEVERITY_LABELS[detail.incident.severity]}</span>
                  <span className={`ops-pill ${STATUS_TONES[detail.incident.status]}`}>{STATUS_LABELS[detail.incident.status]}</span>
                </div>

                {canManage ? (
                  <div className="toolbar" style={{ marginBottom: 16 }}>
                    <select className="field-input" value={detail.incident.status} onChange={(e) => void patch(selectedId, { status: e.target.value as IncidentStatus })} aria-label="Status">
                      {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                    </select>
                    <select className="field-input" value={detail.incident.severity} onChange={(e) => void patch(selectedId, { severity: e.target.value as IncidentSeverity })} aria-label="Severity">
                      {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_SHORT[s]}</option>)}
                    </select>
                    <span className="etch" style={{ marginLeft: 'auto' }}>{detailBusy ? 'Updating…' : ''}</span>
                  </div>
                ) : null}

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
              {SEVERITIES.map((s) => <option key={s} value={s}>{SEVERITY_LABELS[s]}</option>)}
            </select>
          </Field>
        </form>
      </Modal>
    </Shell>
  )
}
