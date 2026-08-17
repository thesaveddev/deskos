import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, Field } from '../components/ui.js'
import {
  deleteDevice,
  getDevice,
  listDeviceGroups,
  updateDevice,
  type Device,
  type DeviceAlert,
  type DeviceGroup,
  type DeviceMetric,
} from '../lib/devices.js'
import { formatWhen, STATUS_LABELS } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'
import { createSession, type RemoteSessionType } from '../lib/sessions.js'
import { Shell } from '../components/Shell.js'

function statusLabel(status: Device['status']): string {
  return status === 'never' ? 'Never checked in' : status[0].toUpperCase() + status.slice(1)
}

function metricTone(value: number, kind: 'cpu' | 'memory' | 'disk'): 'ok' | 'warn' | 'crit' {
  const warn = kind === 'disk' ? 75 : 70
  const crit = kind === 'disk' ? 90 : 90
  return value >= crit ? 'crit' : value >= warn ? 'warn' : 'ok'
}

function MetricBar({ label, value, kind }: { label: string; value: number; kind: 'cpu' | 'memory' | 'disk' }) {
  const tone = metricTone(value, kind)
  return (
    <div className="metric-row">
      <div className="metric-row-head">
        <span>{label}</span>
        <span className={`mono metric-value metric-${tone}`}>{value.toFixed(1)}%</span>
      </div>
      <div className="metric-track"><div className={`metric-fill metric-fill-${tone}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
    </div>
  )
}

function alertStatus(alert: DeviceAlert): string {
  return alert.resolved_at ? 'Resolved' : alert.severity
}

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const canManageDevice = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('device.manage')))
  const canRemote = useAuth((state) => state.memberships.some((membership) => membership.permissions.some((permission) => permission.startsWith('remote.'))))
  const canRemoteControl = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.control')))
  const canRemoteElevated = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.elevated')))
  const [device, setDevice] = useState<Device | null>(null)
  const [metrics, setMetrics] = useState<DeviceMetric[]>([])
  const [alerts, setAlerts] = useState<DeviceAlert[]>([])
  const [tickets, setTickets] = useState<Array<{ id: string; number: number; subject: string; status: string; priority: string; created_at: string }>>([])
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showSessionRequest, setShowSessionRequest] = useState(false)
  const [sessionType, setSessionType] = useState<RemoteSessionType>('attended')
  const [sessionReason, setSessionReason] = useState('')
  const [allowControlInput, setAllowControlInput] = useState(false)
  const [allowClipboard, setAllowClipboard] = useState(false)
  const [allowTerminal, setAllowTerminal] = useState(false)
  const [allowFileTransfer, setAllowFileTransfer] = useState(false)
  const [allowSystemManage, setAllowSystemManage] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  useEffect(() => {
    setAllowControlInput(sessionType !== 'inspection' && canRemoteControl)
  }, [canRemoteControl, sessionType])

  const load = useCallback(async () => {
    if (!id) return
    setError(null)
    try {
      const response = await getDevice(id)
      setDevice(response.device)
      setName(response.device.name)
      setGroupId(response.device.group_id ?? '')
      setMetrics(response.metrics)
      setAlerts(response.alerts)
      setTickets(response.tickets)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load device')
    }
  }, [id])

  useEffect(() => {
    void load()
    void listDeviceGroups().then((response) => setGroups(response.groups)).catch(() => setGroups([]))
  }, [load])

  const latestMetric = metrics.length > 0 ? metrics[metrics.length - 1] : null
  const recentMetrics = useMemo(() => metrics.slice(-12), [metrics])

  const requestSession = async (event: FormEvent) => {
    event.preventDefault()
    if (!device || sessionBusy || !sessionReason.trim()) return
    setSessionBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await createSession({
        deviceId: device.id,
        type: sessionType,
        permissions: [
          'view_screen',
          ...(allowControlInput && sessionType !== 'inspection' ? ['control_input'] : []),
          ...(allowClipboard && sessionType !== 'inspection' ? ['clipboard'] : []),
          ...(allowTerminal && sessionType !== 'inspection' ? ['terminal', 'elevation'] : []),
          ...(allowFileTransfer && sessionType !== 'inspection' ? ['file_transfer'] : []),
          ...(allowSystemManage && sessionType !== 'inspection' ? ['system_manage', 'elevation'] : []),
        ],
        reason: sessionReason.trim(),
      })
      setShowSessionRequest(false)
      setSessionReason('')
      setAllowClipboard(false)
      setAllowTerminal(false)
      setAllowFileTransfer(false)
      setAllowSystemManage(false)
      navigate(`/sessions/${response.session.id}`, { state: { joinToken: response.joinToken } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request remote session')
    } finally {
      setSessionBusy(false)
    }
  }

  const removeDevice = async () => {
    if (!device || deleteBusy || !window.confirm(`Remove “${device.name}” from DeskOS? This revokes its agent credential, ends its remote sessions, and cannot be undone.`)) return
    setDeleteBusy(true)
    setError(null)
    try {
      await deleteDevice(device.id)
      navigate('/devices')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove device')
    } finally {
      setDeleteBusy(false)
    }
  }

  const saveMetadata = async (event: FormEvent) => {
    event.preventDefault()
    if (!device || busy || !name.trim()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await updateDevice(device.id, { name: name.trim(), groupId: groupId || null })
      setDevice((current) => current ? { ...current, ...response.device, group_name: groups.find((group) => group.id === groupId)?.name ?? null } : current)
      setNotice('Device details saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save device details')
    } finally {
      setBusy(false)
    }
  }

  if (error && !device) {
    return <Shell><Alert kind="error">{error}</Alert><Link to="/devices" className="back-link">← Back to devices</Link></Shell>
  }

  if (!device) {
    return <Shell><span className="etch">Loading device…</span></Shell>
  }

  return (
    <Shell>
      <div className="detail-breadcrumb"><Link to="/devices">Devices</Link><span>/</span><span>{device.name}</span></div>
      <div className="device-detail-head">
        <div>
          <div className="ticket-id-row">
            <span className="device-avatar device-avatar-large">{device.name.slice(0, 1).toUpperCase()}</span>
            <span className={`status-pill status-${device.status}`}>{statusLabel(device.status)}</span>
            <span className="mono muted">{device.agent_version ? `agent ${device.agent_version}` : 'agent version unknown'}</span>
          </div>
          <h1 className="ticket-subject">{device.name}</h1>
          <div className="ticket-meta mono">
            {device.hostname || 'No hostname'} · {device.os || 'Unknown OS'} {device.os_version} · enrolled {formatWhen(device.enrolled_at)}
          </div>
        </div>
        <div className="device-detail-actions">
          {canRemote ? <button className="btn btn-primary btn-sm" onClick={() => setShowSessionRequest((visible) => !visible)}>{showSessionRequest ? 'Cancel request' : 'Request remote session'}</button> : null}
          {canManageDevice ? <button className="btn btn-danger btn-sm" onClick={() => void removeDevice()} disabled={deleteBusy}>{deleteBusy ? 'Removing…' : 'Remove device'}</button> : null}
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/devices')}>Back to devices</button>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {showSessionRequest && canRemote ? (
        <section className="session-request-panel">
          <div className="detail-card-head"><h2>Request a remote session</h2><span className="muted mono">explicit permissions</span></div>
          <form className="session-request-form" onSubmit={requestSession}>
            <Field label="Session type">
              <select className="field-input" value={sessionType} onChange={(event) => setSessionType(event.target.value as RemoteSessionType)}>
                <option value="attended">Attended — ask the user for consent</option>
                <option value="unattended">Unattended — policy-gated</option>
                <option value="inspection">Inspection — telemetry only</option>
              </select>
            </Field>
            <Field label="Reason" hint="Shown in the consent prompt and recorded in the audit trail.">
              <input className="field-input" value={sessionReason} onChange={(event) => setSessionReason(event.target.value)} placeholder="Why do you need access?" required />
            </Field>
            <label className="checkbox-field session-permission-check">
              <input
                type="checkbox"
                checked={allowControlInput}
                onChange={(event) => setAllowControlInput(event.target.checked)}
                disabled={!canRemoteControl || sessionType === 'inspection'}
              />
              <span className="field-label">Allow keyboard and mouse input</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input
                type="checkbox"
                checked={allowClipboard}
                onChange={(event) => setAllowClipboard(event.target.checked)}
                disabled={!canRemoteControl || sessionType === 'inspection'}
              />
              <span className="field-label">Allow clipboard synchronization</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input
                type="checkbox"
                checked={allowTerminal}
                onChange={(event) => setAllowTerminal(event.target.checked)}
                disabled={!canRemoteControl || !canRemoteElevated || sessionType === 'inspection'}
              />
              <span className="field-label">Allow elevated terminal (audited)</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input
                type="checkbox"
                checked={allowFileTransfer}
                onChange={(event) => setAllowFileTransfer(event.target.checked)}
                disabled={!canRemoteControl || sessionType === 'inspection'}
              />
              <span className="field-label">Allow file transfer</span>
            </label>
            <label className="checkbox-field session-permission-check">
              <input
                type="checkbox"
                checked={allowSystemManage}
                onChange={(event) => setAllowSystemManage(event.target.checked)}
                disabled={!canRemoteControl || !canRemoteElevated || sessionType === 'inspection'}
              />
              <span className="field-label">Allow process/service management (elevated)</span>
            </label>
            <button className="btn btn-primary btn-sm" type="submit" disabled={sessionBusy || !sessionReason.trim()}>{sessionBusy ? 'Requesting…' : 'Request session'}</button>
          </form>
        </section>
      ) : null}

      <div className="device-summary-grid">
        <div className="device-summary-card">
          <span className="etch">Last seen</span>
          <strong>{device.last_seen_at ? formatWhen(device.last_seen_at) : 'Never'}</strong>
          <span className="muted">{device.ip_address || 'No IP reported'}</span>
        </div>
        <div className="device-summary-card">
          <span className="etch">Open alerts</span>
          <strong className={alerts.some((alert) => !alert.resolved_at) ? 'metric-crit' : ''}>{alerts.filter((alert) => !alert.resolved_at).length}</strong>
          <span className="muted">{alerts.length} total recorded</span>
        </div>
        <div className="device-summary-card">
          <span className="etch">Linked tickets</span>
          <strong>{tickets.length}</strong>
          <span className="muted">latest device context</span>
        </div>
      </div>

      <div className="device-detail-grid">
        <div className="device-detail-main">
          <section className="detail-card">
            <div className="detail-card-head"><h2>Health</h2><span className="muted mono">latest telemetry</span></div>
            {latestMetric ? (
              <div className="metric-list">
                <MetricBar label="CPU" value={latestMetric.cpu_pct} kind="cpu" />
                <MetricBar label="Memory" value={latestMetric.mem_pct} kind="memory" />
                <MetricBar label="Disk" value={latestMetric.disk_pct} kind="disk" />
              </div>
            ) : (
              <div className="detail-empty">No telemetry has been reported by this device yet.</div>
            )}
            {recentMetrics.length > 1 ? (
              <div className="metric-history">
                {recentMetrics.map((metric) => (
                  <div key={metric.id} className="metric-history-row" title={new Date(metric.recorded_at).toLocaleString()}>
                    <span className="mono">{formatWhen(metric.recorded_at)}</span>
                    <span className="metric-history-bars"><i style={{ height: `${Math.max(4, metric.cpu_pct)}%` }} /><i style={{ height: `${Math.max(4, metric.mem_pct)}%` }} /><i style={{ height: `${Math.max(4, metric.disk_pct)}%` }} /></span>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="detail-card">
            <div className="detail-card-head"><h2>Alerts</h2><span className="muted mono">offline and disk conditions</span></div>
            {alerts.length === 0 ? <div className="detail-empty">No alerts recorded for this device.</div> : (
              <div className="device-alert-list">
                {alerts.map((alert) => (
                  <div key={alert.id} className={`device-alert-row${alert.resolved_at ? ' resolved' : ''}`}>
                    <span className={`alert-severity severity-${alert.severity}`} aria-hidden="true" />
                    <div className="device-alert-main"><strong>{alert.message}</strong><span className="muted mono">{alertStatus(alert)} · {formatWhen(alert.created_at)}</span></div>
                    {alert.ticket_id && alert.ticket_number ? <Link to={`/tickets/${alert.ticket_id}`} className="mono">#{alert.ticket_number}</Link> : null}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="detail-card">
            <div className="detail-card-head"><h2>Linked tickets</h2><span className="muted mono">device context</span></div>
            {tickets.length === 0 ? <div className="detail-empty">No tickets are linked to this device.</div> : (
              <div className="device-ticket-list">
                {tickets.map((ticket) => (
                  <Link key={ticket.id} to={`/tickets/${ticket.id}`} className="device-ticket-row">
                    <span className="mono">#{ticket.number}</span>
                    <strong>{ticket.subject}</strong>
                    <span className={`status-pill status-${ticket.status}`}>{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
                    <span className="mono muted">{ticket.priority.toUpperCase()}</span>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>

        <aside className="device-detail-side">
          <section className="detail-card">
            <div className="detail-card-head"><h2>Inventory</h2></div>
            <dl className="inventory-list">
              <div><dt>Hostname</dt><dd>{device.hostname || '—'}</dd></div>
              <div><dt>Operating system</dt><dd>{device.os || '—'} {device.os_version}</dd></div>
              <div><dt>Architecture</dt><dd>{device.arch || '—'}</dd></div>
              <div><dt>IP address</dt><dd className="mono">{device.ip_address || '—'}</dd></div>
              <div><dt>Agent version</dt><dd className="mono">{device.agent_version || '—'}</dd></div>
            </dl>
          </section>

          <section className="detail-card">
            <div className="detail-card-head"><h2>Device details</h2></div>
            <form onSubmit={saveMetadata}>
              <Field label="Display name">
                <input className="field-input" value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="Group">
                <select className="field-input" value={groupId} onChange={(event) => setGroupId(event.target.value)}>
                  <option value="">Ungrouped</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </Field>
              <button className="btn btn-primary btn-sm btn-block" type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save details'}</button>
            </form>
          </section>
        </aside>
      </div>
    </Shell>
  )
}
