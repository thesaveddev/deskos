import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useOffsetPagination } from '../components/Pagination.js'
import { Alert, Field } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  createAdhocSession,
  endSession,
  listAdhocSessions,
  listSessions,
  revokeAdhocSession,
  type AdhocSession,
  type AdhocSessionRecord,
  type RemoteSession,
  type RemoteSessionState,
} from '../lib/sessions.js'
import { formatWhen } from '../lib/tickets.js'

const STATE_OPTIONS: Array<{ value: '' | RemoteSessionState; label: string }> = [
  { value: '', label: 'All sessions' },
  { value: 'requested', label: 'Requested' },
  { value: 'consent_pending', label: 'Awaiting consent' },
  { value: 'connecting', label: 'Connecting' },
  { value: 'active', label: 'Active' },
  { value: 'ended', label: 'Ended' },
  { value: 'denied', label: 'Denied' },
]

function stateLabel(state: RemoteSessionState): string {
  return state === 'consent_pending' ? 'Awaiting consent' : state[0].toUpperCase() + state.slice(1)
}

function typeLabel(type: RemoteSession['type']): string {
  return type[0].toUpperCase() + type.slice(1)
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const pagination = useOffsetPagination(20)
  const [state, setState] = useState<'' | RemoteSessionState>('')
  const [error, setError] = useState<string | null>(null)
  const [endingId, setEndingId] = useState<string | null>(null)
  const canRemoteControl = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.control')))
  const canRemoteElevated = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.elevated')))
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [codeReason, setCodeReason] = useState('')
  const [codeExpiresInMin, setCodeExpiresInMin] = useState(30)
  const [allowCodeControl, setAllowCodeControl] = useState(true)
  const [allowCodeClipboard, setAllowCodeClipboard] = useState(false)
  const [allowCodeTerminal, setAllowCodeTerminal] = useState(false)
  const [allowCodeFileTransfer, setAllowCodeFileTransfer] = useState(false)
  const [allowCodeSystemManage, setAllowCodeSystemManage] = useState(false)
  const [codeBusy, setCodeBusy] = useState(false)
  const [generatedCode, setGeneratedCode] = useState<AdhocSession | null>(null)
  const [copied, setCopied] = useState(false)
  const [adhocSessions, setAdhocSessions] = useState<AdhocSessionRecord[] | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadCodes = useCallback(async () => {
    try {
      setAdhocSessions((await listAdhocSessions()).sessions)
    } catch {
      setAdhocSessions([])
    }
  }, [])

  const toggleCodePanel = () => {
    const next = !showCodePanel
    setShowCodePanel(next)
    setGeneratedCode(null)
    if (next) void loadCodes()
  }

  const revokeCode = async (record: AdhocSessionRecord) => {
    if (revokingId) return
    setRevokingId(record.id)
    setError(null)
    try {
      await revokeAdhocSession(record.id)
      await loadCodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke support code')
    } finally {
      setRevokingId(null)
    }
  }

  const generateCode = async (event: FormEvent) => {
    event.preventDefault()
    if (codeBusy) return
    setCodeBusy(true)
    setError(null)
    setGeneratedCode(null)
    setCopied(false)
    try {
      const result = await createAdhocSession({
        permissions: [
          'view_screen',
          ...(allowCodeControl ? ['control_input'] : []),
          ...(allowCodeClipboard ? ['clipboard'] : []),
          ...(allowCodeTerminal ? ['terminal', 'elevation'] : []),
          ...(allowCodeFileTransfer ? ['file_transfer'] : []),
          ...(allowCodeSystemManage ? ['system_manage', 'elevation'] : []),
        ],
        reason: codeReason.trim() || undefined,
        expiresInMin: codeExpiresInMin,
      })
      setGeneratedCode(result)
      void loadCodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate support code')
    } finally {
      setCodeBusy(false)
    }
  }

  const copyConnectLink = async () => {
    if (!generatedCode) return
    try {
      await navigator.clipboard.writeText(generatedCode.connectUrl)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const res = await listSessions({ state: state || undefined, limit: pagination.pageSize, offset: pagination.offset })
      setSessions(res.sessions)
      setTotal(res.total ?? res.sessions.length)
    } catch (err) {
      setSessions([])
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    }
    setLoading(false)
  }, [state, pagination.page, pagination.pageSize])

  useEffect(() => {
    void load()
  }, [load])

  // While the support-code panel is open, keep the recent-codes list fresh so
  // a claim flips to its "Open live session" affordance without a manual refresh.
  useEffect(() => {
    if (!showCodePanel) return
    const timer = window.setInterval(() => {
      void loadCodes()
    }, 3000)
    return () => window.clearInterval(timer)
  }, [showCodePanel, loadCodes])

  const stop = async (session: RemoteSession) => {
    if (endingId) return
    setEndingId(session.id)
    setError(null)
    try {
      await endSession(session.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end session')
    } finally {
      setEndingId(null)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1 className="page-title">Remote sessions</h1>
          <p className="page-subtitle">Consent-gated endpoint connections and session state.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={toggleCodePanel}>{showCodePanel ? 'Close' : 'Generate support code'}</button>
          <select className="field-input session-filter" value={state} onChange={(event) => setState(event.target.value as '' | RemoteSessionState)} aria-label="Filter sessions">
            {STATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {showCodePanel ? (
        <section className="session-request-panel">
          <div className="detail-card-head"><h2>Generate a support code</h2><span className="muted mono">ad-hoc device — no enrollment needed</span></div>
          <form className="support-code-form" onSubmit={generateCode}>
            <Field label="Reason" hint="Shown to the person you're helping and recorded in the audit trail.">
              <input className="field-input" value={codeReason} onChange={(event) => setCodeReason(event.target.value)} placeholder="Why do you need access?" />
            </Field>
            <Field label="Expires in (minutes)" hint="The code and link stop working after this long.">
              <input className="field-input" type="number" min={1} max={1440} value={codeExpiresInMin} onChange={(event) => setCodeExpiresInMin(Math.max(1, Math.min(1440, Number(event.target.value) || 30)))} />
            </Field>
            <label className="checkbox-field session-permission-check">
              <input type="checkbox" checked={allowCodeControl} onChange={(event) => setAllowCodeControl(event.target.checked)} disabled={!canRemoteControl} />
              <span className="field-label">Allow keyboard and mouse input</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input type="checkbox" checked={allowCodeClipboard} onChange={(event) => setAllowCodeClipboard(event.target.checked)} disabled={!canRemoteControl} />
              <span className="field-label">Allow clipboard synchronization</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input type="checkbox" checked={allowCodeTerminal} onChange={(event) => setAllowCodeTerminal(event.target.checked)} disabled={!canRemoteControl || !canRemoteElevated} />
              <span className="field-label">Allow elevated terminal (audited)</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input type="checkbox" checked={allowCodeFileTransfer} onChange={(event) => setAllowCodeFileTransfer(event.target.checked)} disabled={!canRemoteControl} />
              <span className="field-label">Allow file transfer</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input type="checkbox" checked={allowCodeSystemManage} onChange={(event) => setAllowCodeSystemManage(event.target.checked)} disabled={!canRemoteControl || !canRemoteElevated} />
              <span className="field-label">Allow process/service management (elevated)</span>
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={codeBusy}>{codeBusy ? 'Generating…' : 'Generate code'}</button>
          </form>

          {generatedCode ? (
            <div className="support-code-result">
              <div className="support-code-digits">{generatedCode.code}</div>
              <div className="mono muted">{generatedCode.connectUrl}</div>
              <div className="support-code-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void copyConnectLink()}>{copied ? 'Copied' : 'Copy link'}</button>
                <span className="muted mono">expires {formatWhen(generatedCode.expiresAt)}</span>
              </div>
              <p className="muted">Tell the person to open the link (or enter the code at your support URL) and approve the access request. No installation or login is required on their side.</p>
            </div>
          ) : null}

          <div className="adhoc-list">
            <h3>Recent support codes</h3>
            {adhocSessions === null ? <span className="etch">Loading…</span> : null}
            {adhocSessions && adhocSessions.length === 0 ? <span className="muted">No support codes yet.</span> : null}
            {adhocSessions && adhocSessions.length > 0 ? (
              <div className="adhoc-list-rows">
                {adhocSessions.map((record) => (
                  <div className="adhoc-row" key={record.id}>
                    <div className="adhoc-row-main">
                      <span className={`status-pill adhoc-state-${record.state}`}>{record.state}</span>
                      {record.remote_session_state ? <span className={`status-pill session-state-${record.remote_session_state}`}>{stateLabel(record.remote_session_state)}</span> : null}
                      <span className="muted">
                        {record.reason || 'No reason'} · created {formatWhen(record.created_at)}
                        {record.device_name ? <> · {record.device_name}</> : null}
                      </span>
                    </div>
                    <div className="adhoc-row-actions">
                      {record.remote_session_id ? (
                        <Link to={`/sessions/${record.remote_session_id}`} className="btn btn-primary btn-sm">Open live session</Link>
                      ) : null}
                      {record.state === 'open' ? (
                        <button className="btn btn-ghost btn-sm" onClick={() => void revokeCode(record)} disabled={revokingId === record.id}>
                          {revokingId === record.id ? 'Revoking…' : 'Revoke'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
      {sessions === null ? <span className="etch">Loading sessions…</span> : null}
      {sessions && sessions.length === 0 ? (
        <div className="empty-state">
          <p>No remote sessions match this view.</p>
          <Link to="/devices" className="btn btn-primary">Choose a device</Link>
        </div>
      ) : null}
      {sessions && sessions.length > 0 ? (
        <div className="session-list">
          {sessions.map((session) => (
            <div className="session-card" key={session.id}>
              <div className="session-card-main">
                <div className="session-card-title">
                  <span className={`status-pill session-state-${session.state}`}>{stateLabel(session.state)}</span>
                  <span className="mono muted">{typeLabel(session.type)}</span>
                </div>
                <Link to={`/devices/${session.device_id}`} className="session-device-link">{session.device_name ?? 'Device'}{session.hostname ? ` · ${session.hostname}` : ''}</Link>
                <div className="session-card-meta mono">
                  requested {formatWhen(session.created_at)} · {session.reason || 'No reason recorded'}
                  {session.ticket_number ? <> · <Link to={`/tickets/${session.ticket_id}`}>ticket #{session.ticket_number}</Link></> : null}
                </div>
              </div>
              <div className="session-card-actions">
                <Link to={`/sessions/${session.id}`} className="btn btn-ghost btn-sm">Open console</Link>
                {session.state !== 'ended' && session.state !== 'denied' && session.state !== 'expired' ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => void stop(session)} disabled={endingId === session.id}>
                    {endingId === session.id ? 'Ending…' : 'End session'}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {sessions && sessions.length > 0 && (
        <Pagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          totalItems={total}
          loading={loading}
          onPageChange={pagination.goToPage}
          onPageSizeChange={pagination.changeSize}
        />
      )}
    </Shell>
  )
}
