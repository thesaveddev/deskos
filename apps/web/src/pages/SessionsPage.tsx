import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useOffsetPagination } from '../components/Pagination.js'
import { Alert, Field, Modal } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import {
  createAdhocSession,
  emailAdhocSession,
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
  const [view, setView] = useState<'sessions' | 'codes'>('sessions')
  const [error, setError] = useState<string | null>(null)
  const [endingId, setEndingId] = useState<string | null>(null)
  const canRemoteControl = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.control')))
  const canRemoteElevated = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.elevated')))
  const [showCodePanel, setShowCodePanel] = useState(false)
  const [codeReason, setCodeReason] = useState('')
  const [codeExpiresInMin, setCodeExpiresInMin] = useState(30)
  const [emailMode, setEmailMode] = useState<'code' | 'email_link'>('email_link')
  const [allowCodeControl, setAllowCodeControl] = useState(true)
  const [allowCodeClipboard, setAllowCodeClipboard] = useState(false)
  const [allowCodeTerminal, setAllowCodeTerminal] = useState(false)
  const [allowCodeFileTransfer, setAllowCodeFileTransfer] = useState(false)
  const [allowCodeSystemManage, setAllowCodeSystemManage] = useState(false)
  const [codeBusy, setCodeBusy] = useState(false)
  const [generatedCode, setGeneratedCode] = useState<AdhocSession | null>(null)
  const [copied, setCopied] = useState(false)
  const [emailRecipient, setEmailRecipient] = useState('')
  const [emailBusy, setEmailBusy] = useState(false)
  const [emailNotice, setEmailNotice] = useState<string | null>(null)
  const [adhocSessions, setAdhocSessions] = useState<AdhocSessionRecord[] | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const loadCodes = useCallback(async () => {
    try {
      const result = await listAdhocSessions()
      // Historical codes are not useful in the working queue. Keep the page
      // focused on codes that can still be acted on or have a live session.
      setAdhocSessions(result.sessions.filter((session) => session.state === 'open' || Boolean(session.remote_session_id)))
    } catch {
      setAdhocSessions([])
    }
  }, [])

  const toggleCodePanel = () => {
    const next = !showCodePanel
    setShowCodePanel(next)
    setGeneratedCode(null)
    setEmailRecipient('')
    setEmailNotice(null)
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
        codeLength: 12,
      })
      setGeneratedCode(result)
      void loadCodes()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not generate support code')
    } finally {
      setCodeBusy(false)
    }
  }

  const emailCode = async () => {
    if (!generatedCode || !emailRecipient.trim() || emailBusy) return
    setEmailBusy(true)
    setEmailNotice(null)
    try {
      await emailAdhocSession(generatedCode.id, generatedCode.code, emailRecipient.trim(), emailMode)
      setEmailNotice(emailMode === 'email_link'
        ? `A one-time secure link was queued for ${emailRecipient.trim()}.`
        : `Support code instructions were queued for ${emailRecipient.trim()}.`)
    } catch (err) {
      setEmailNotice(err instanceof Error ? err.message : 'Could not email support instructions')
    } finally {
      setEmailBusy(false)
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
  }, [state, pagination.offset, pagination.pageSize])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the recent-codes list fresh so a claim flips to its "Open live
  // session" affordance without a manual refresh.
  useEffect(() => {
    void loadCodes()
    const timer = window.setInterval(() => {
      void loadCodes()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [loadCodes])

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

  const sessionTabs = [
    { label: 'All sessions', value: '', count: total },
    { label: 'Awaiting consent', value: 'consent_pending', count: state === 'consent_pending' ? total : undefined },
    { label: 'Active', value: 'active', count: state === 'active' ? total : undefined },
    { label: 'Ended', value: 'ended', count: state === 'ended' ? total : undefined },
  ] as const

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1 className="page-title">Remote sessions</h1>
          <p className="page-subtitle">Consent-gated endpoint connections and session state.</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={toggleCodePanel}><Icon name="key" size={15} />Generate support code</button>
          {view === 'sessions' ? (
            <select className="field-input session-filter" value={state} onChange={(event) => setState(event.target.value as '' | RemoteSessionState)} aria-label="Filter sessions">
              {STATE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : null}
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <nav className="workspace-tabs session-workspace-tabs" aria-label="Session workspace">
        <button type="button" className={`workspace-tab${view === 'sessions' ? ' active' : ''}`} onClick={() => setView('sessions')}>Sessions{view === 'sessions' && total > 0 ? <span>{total}</span> : null}</button>
        <button type="button" className={`workspace-tab${view === 'codes' ? ' active' : ''}`} onClick={() => setView('codes')}>Support codes{adhocSessions ? <span>{adhocSessions.length}</span> : null}</button>
        <span className="workspace-tab-spacer" />
        <span className="workspace-context">{view === 'sessions' ? (loading ? 'Refreshing…' : `${sessions.length} shown`) : (adhocSessions === null ? 'Loading…' : `${adhocSessions.length} active`)}</span>
      </nav>

      {view === 'sessions' ? (
        <nav className="workspace-tabs session-workspace-tabs" aria-label="Session state">
          {sessionTabs.map((tab) => <button key={tab.label} type="button" className={`workspace-tab${state === tab.value ? ' active' : ''}`} onClick={() => { setState(tab.value as '' | RemoteSessionState); pagination.goToPage(0) }}>{tab.label}{tab.count !== undefined ? <span>{tab.count}</span> : null}</button>)}
        </nav>
      ) : null}

      {showCodePanel ? (
        <Modal open={showCodePanel} onClose={() => { if (!codeBusy && !emailBusy) setShowCodePanel(false) }} title="Generate a support code" width={620}>
          <div className="support-code-panel">
            <p className="support-code-intro">Create a single-use 12-digit code or secure link for attended support. No enrollment or preinstalled software is required.</p>
            <form className="support-code-form" onSubmit={generateCode}>
              <Field label="Reason" hint="Shown to the person you're helping and recorded in the audit trail.">
                <input className="field-input" value={codeReason} onChange={(event) => setCodeReason(event.target.value)} placeholder="e.g. Troubleshooting Outlook sign-in" />
              </Field>
              <Field label="Expires in">
                <select className="field-input" value={codeExpiresInMin} onChange={(event) => setCodeExpiresInMin(Number(event.target.value))}>
                  <option value={15}>15 minutes</option>
                  <option value={30}>30 minutes</option>
                  <option value={60}>1 hour</option>
                  <option value={120}>2 hours</option>
                  <option value={240}>4 hours</option>
                  <option value={1440}>24 hours</option>
                </select>
              </Field>

              <div className="support-permissions">
                <div className="support-permissions-head">
                  <h3>Access permissions</h3>
                  <span className="muted">The endpoint user must consent to each capability before it activates.</span>
                </div>
                <label className="support-permission-row">
                  <input type="checkbox" checked={allowCodeControl} onChange={(event) => setAllowCodeControl(event.target.checked)} disabled={!canRemoteControl} />
                  <span className="support-permission-copy"><strong>Keyboard and mouse input</strong><small>Control the pointer and type on the endpoint.</small></span>
                </label>
                <label className="support-permission-row">
                  <input type="checkbox" checked={allowCodeClipboard} onChange={(event) => setAllowCodeClipboard(event.target.checked)} disabled={!canRemoteControl} />
                  <span className="support-permission-copy"><strong>Clipboard synchronization</strong><small>Share clipboard contents between technician and endpoint.</small></span>
                </label>
                <label className="support-permission-row">
                  <input type="checkbox" checked={allowCodeTerminal} onChange={(event) => setAllowCodeTerminal(event.target.checked)} disabled={!canRemoteControl || !canRemoteElevated} />
                  <span className="support-permission-copy"><strong>Elevated terminal</strong><small>Open an audited terminal with elevated privileges.</small></span>
                </label>
                <label className="support-permission-row">
                  <input type="checkbox" checked={allowCodeFileTransfer} onChange={(event) => setAllowCodeFileTransfer(event.target.checked)} disabled={!canRemoteControl} />
                  <span className="support-permission-copy"><strong>File transfer</strong><small>Send and receive files during the session.</small></span>
                </label>
                <label className="support-permission-row">
                  <input type="checkbox" checked={allowCodeSystemManage} onChange={(event) => setAllowCodeSystemManage(event.target.checked)} disabled={!canRemoteControl || !canRemoteElevated} />
                  <span className="support-permission-copy"><strong>Process & service management</strong><small>Start, stop, and inspect processes and services (elevated).</small></span>
                </label>
              </div>

              <div className="support-code-form-actions">
                <button className="btn btn-primary" type="submit" disabled={codeBusy}><Icon name="key" size={15} />{codeBusy ? 'Generating…' : 'Generate code'}</button>
              </div>
            </form>

            {generatedCode ? (
              <div className="support-code-result">
                <div className="support-code-result-head">
                  <span className="etch">12-digit support code</span>
                  <span className="muted mono">expires {formatWhen(generatedCode.expiresAt)}</span>
                </div>
                <div className="support-code-digits">{generatedCode.code}</div>
                <div className="mono muted support-code-url">{generatedCode.connectUrl}</div>
                <div className="support-code-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => void copyConnectLink()}><Icon name="copy" size={14} />{copied ? 'Copied' : 'Copy secure link'}</button>
                </div>
                <div className="support-code-email">
                  <div><strong>Email these instructions</strong><span className="muted">Send the secure link (recommended) or the numeric code to the person you're helping.</span></div>
                  <div className="support-code-email-row"><input className="field-input" type="email" placeholder="user@example.com" value={emailRecipient} onChange={(event) => setEmailRecipient(event.target.value)} /><select className="field-input" value={emailMode} onChange={(event) => setEmailMode(event.target.value as 'code' | 'email_link')} aria-label="Email support method"><option value="email_link">Secure link + fingerprint</option><option value="code">Numeric code</option></select><button className="btn btn-ghost btn-sm" type="button" onClick={() => void emailCode()} disabled={emailBusy || !emailRecipient.trim()}><Icon name="mail" size={14} />{emailBusy ? 'Sending…' : 'Email user'}</button></div>
                  {emailNotice ? <span className="muted">{emailNotice}</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
      {view === 'sessions' ? (
        <>
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
                    <Link to={`/sessions/${session.id}`} className="btn btn-ghost btn-sm"><Icon name="monitor" size={14} />Open console</Link>
                    {session.state !== 'ended' && session.state !== 'denied' && session.state !== 'expired' ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => void stop(session)} disabled={endingId === session.id}>
                        <Icon name="stop" size={14} />{endingId === session.id ? 'Ending…' : 'End session'}
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
        </>
      ) : (
        <div className="adhoc-list adhoc-list-page">
          <div className="adhoc-list-head">
            <div><h3>Active support codes</h3><p className="muted">Only open codes and codes with a live session are shown. Expired and revoked codes are removed automatically from this view.</p></div>
            <button className="btn btn-ghost btn-sm" onClick={() => void loadCodes()}><Icon name="refresh" size={14} />Refresh</button>
          </div>
          {adhocSessions === null ? <span className="etch">Loading support codes…</span> : null}
          {adhocSessions && adhocSessions.length === 0 ? (
            <div className="empty-state">
              <Icon name="key" size={24} />
              <strong>No support codes yet</strong>
              <span>Generate a code to share with someone who needs help.</span>
              <button className="btn btn-primary btn-sm" onClick={toggleCodePanel}><Icon name="key" size={14} />Generate support code</button>
            </div>
          ) : null}
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
                      <Link to={`/sessions/${record.remote_session_id}`} className="btn btn-primary btn-sm"><Icon name="monitor" size={14} />Open live session</Link>
                    ) : null}
                    {record.state === 'open' ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => void revokeCode(record)} disabled={revokingId === record.id}>
                        <Icon name="close" size={14} />{revokingId === record.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Shell>
  )
}
