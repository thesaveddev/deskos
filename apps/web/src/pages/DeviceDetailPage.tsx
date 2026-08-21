import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Alert, Field, Modal, useConfirm } from '../components/ui.js'
import {
  createDeviceAssignment,
  deleteDevice,
  getDevice,
  listDeviceGroups,
  returnDeviceAssignment,
  updateDevice,
  type Device,
  type DeviceAlert,
  type DeviceAssignment,
  type DeviceGroup,
  type DeviceMetric,
  type DeviceType,
} from '../lib/devices.js'
import { formatWhen, STATUS_LABELS } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'
import { MfaQrCode } from '../components/MfaQrCode.js'
import { createSession, type RemoteSessionType } from '../lib/sessions.js'
import { getDeviceDex, type DeviceDex } from '../lib/dex.js'
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

function formatUptime(seconds?: number | null): string {
  if (seconds == null) return '—'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${days ? `${days}d ` : ''}${hours}h ${minutes}m`
}

export default function DeviceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const canManageDevice = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('device.manage')))
  const confirm = useConfirm()
  const canRemote = useAuth((state) => state.memberships.some((membership) => membership.permissions.some((permission) => permission.startsWith('remote.'))))
  const canRemoteControl = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.control')))
  const canRemoteElevated = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('remote.elevated')))
  const [device, setDevice] = useState<Device | null>(null)
  const [metrics, setMetrics] = useState<DeviceMetric[]>([])
  const [alerts, setAlerts] = useState<DeviceAlert[]>([])
  const [tickets, setTickets] = useState<Array<{ id: string; number: number; subject: string; status: string; priority: string; created_at: string }>>([])
  const [dex, setDex] = useState<DeviceDex | null>(null)
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState('')
  const [deviceType, setDeviceType] = useState<DeviceType>('workstation')
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
  const [assignment, setAssignment] = useState<DeviceAssignment | null>(null)
  const [assignmentHistory, setAssignmentHistory] = useState<DeviceAssignment[]>([])
  const [assetIdentity, setAssetIdentity] = useState<{ id: string; tag: string; name: string; type: string; status: string; qr_payload?: string | null; barcode_value?: string | null; warranty_until?: string | null } | null>(null)
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [assignmentStatus, setAssignmentStatus] = useState<'assigned' | 'shared' | 'temporary'>('assigned')
  const [assignmentUserId, setAssignmentUserId] = useState('')
  const [assignmentDepartment, setAssignmentDepartment] = useState('')
  const [assignmentTeamId, setAssignmentTeamId] = useState('')
  const [assignmentLocation, setAssignmentLocation] = useState('')
  const [assignmentReason, setAssignmentReason] = useState('')
  const [assignmentNotes, setAssignmentNotes] = useState('')
  const [expectedReturnAt, setExpectedReturnAt] = useState('')
  const [assignmentMembers, setAssignmentMembers] = useState<Array<{ id: string; name: string; email: string }>>([])
  const [assignmentTeams, setAssignmentTeams] = useState<Array<{ id: string; name: string }>>([])
  const [assignmentBusy, setAssignmentBusy] = useState(false)

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
      setDeviceType(response.device.device_type ?? 'workstation')
      setMetrics(response.metrics)
      setAlerts(response.alerts)
      setTickets(response.tickets)
      setAssignment(response.assignment ?? null)
      setAssignmentHistory(response.assignments ?? [])
      setAssetIdentity(response.asset ?? null)
      try {
        setDex(await getDeviceDex(id))
      } catch {
        // DEX is an optional management capability; do not hide the device
        // page when the current role cannot read its score.
        setDex(null)
      }
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

  const openAssignment = async () => {
    if (!device || !canManageDevice) return
    setAssignmentStatus(assignment?.assignment_status === 'temporary' ? 'temporary' : assignment?.assignment_status === 'shared' ? 'shared' : 'assigned')
    setAssignmentUserId(assignment?.user_id ?? '')
    setAssignmentDepartment(assignment?.department ?? '')
    setAssignmentTeamId(assignment?.team_id ?? '')
    setAssignmentLocation(assignment?.location ?? '')
    setAssignmentReason('')
    setAssignmentNotes('')
    setExpectedReturnAt(assignment?.expected_return_at ? new Date(assignment.expected_return_at).toISOString().slice(0, 16) : '')
    setError(null)
    setAssignmentOpen(true)
    try {
      const [memberResult, teamResult] = await Promise.all([
        api<{ members: Array<{ user_id: string; name: string | null; email: string }> }>('/members?status=active'),
        api<{ teams: Array<{ id: string; name: string }> }>('/teams'),
      ])
      setAssignmentMembers(memberResult.members.map((member) => ({ id: member.user_id, name: member.name || member.email, email: member.email })))
      setAssignmentTeams(teamResult.teams)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load assignment options')
    }
  }

  const saveAssignment = async (event: FormEvent) => {
    event.preventDefault()
    if (!device || assignmentBusy) return
    if (assignmentStatus !== 'shared' && !assignmentUserId) return
    setAssignmentBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await createDeviceAssignment(device.id, {
        userId: assignmentStatus === 'shared' ? null : assignmentUserId,
        assignmentStatus,
        department: assignmentDepartment.trim(),
        teamId: assignmentTeamId || null,
        location: assignmentLocation.trim(),
        expectedReturnAt: expectedReturnAt ? new Date(expectedReturnAt).toISOString() : null,
        reason: assignmentReason.trim(),
        notes: assignmentNotes.trim(),
      })
      setAssignment(result.assignment)
      setAssignmentHistory((history) => [result.assignment, ...history])
      setAssignmentOpen(false)
      setNotice('Device assignment updated. The previous assignment is now in history.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update device assignment')
    } finally {
      setAssignmentBusy(false)
    }
  }

  const returnAssignment = async () => {
    if (!device || !assignment || assignmentBusy) return
    if (!await confirm(`Mark ${device.name} as returned and remove its current staff assignment?`, { title: 'Return device', confirmLabel: 'Mark returned' })) return
    setAssignmentBusy(true)
    setError(null)
    try {
      const result = await returnDeviceAssignment(device.id, assignment.id)
      setAssignment(null)
      setAssignmentHistory((history) => history.map((item) => item.id === result.assignment.id ? result.assignment : item))
      setNotice('Device marked as returned and is now unassigned.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not return device')
    } finally {
      setAssignmentBusy(false)
    }
  }

  const removeDevice = async () => {
    if (!device || deleteBusy || !await confirm(`Remove “${device.name}” from ReyDesk? This revokes its agent credential, ends its remote sessions, and cannot be undone.`, { title: 'Remove device', confirmLabel: 'Remove device', destructive: true })) return
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
      const response = await updateDevice(device.id, { name: name.trim(), groupId: groupId || null, deviceType })
      setDevice((current) => current ? { ...current, ...response.device, device_type: deviceType, group_name: groups.find((group) => group.id === groupId)?.name ?? null } : current)
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
            {device.source === 'directory' ? <span className="directory-device-badge">{device.managed_by === 'intune' ? 'Directory · Intune' : device.managed_by === 'ad' ? 'Directory · AD' : 'Directory'}</span> : null}
            <span className="mono muted">{device.agent_version ? `agent ${device.agent_version}` : 'agent version unknown'}</span>
          </div>
          <h1 className="ticket-subject">{device.name}</h1>
          <div className="ticket-meta mono">
            {device.hostname || 'No hostname'} · {device.os || 'Unknown OS'} {device.os_version} · {device.source === 'directory' ? 'discovered from directory' : `enrolled ${formatWhen(device.enrolled_at)}`}
            {device.manufacturer || device.model ? ` · ${[device.manufacturer, device.model].filter(Boolean).join(' ')}` : ''}
            {device.serial_number ? ` · SN ${device.serial_number}` : ''}
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
          {dex ? <section className="detail-card"><div className="detail-card-head"><div><h2>Digital employee experience</h2><span className="muted mono">health, posture, and availability</span></div><strong className={`device-dex-score ${dex.score && dex.score.score >= 80 ? 'metric-ok' : dex.score && dex.score.score < 60 ? 'metric-crit' : 'metric-warn'}`}>{dex.score?.score ?? '—'}</strong></div>{dex.score ? <><div className="rmm-dex-components">{Object.entries(dex.score.components).map(([name, value]) => <div key={name}><span>{name}</span><strong>{value}</strong></div>)}</div>{dex.history.length > 1 ? <div className="dex-history" aria-label="DEX score history">{dex.history.map((point) => <span key={point.id} title={`${point.score} · ${new Date(point.computed_at).toLocaleString()}`} style={{ height: `${Math.max(8, point.score)}%` }} />)}</div> : <div className="detail-empty">History will appear after more telemetry samples.</div>}</> : <div className="detail-empty">No DEX score has been computed for this endpoint yet.</div>}</section> : null}
          <section className="detail-card">
            <div className="detail-card-head"><h2>Health</h2><span className="muted mono">latest telemetry</span></div>
            {latestMetric ? (
              <div className="metric-list">
                <MetricBar label="CPU" value={latestMetric.cpu_pct} kind="cpu" />
                <MetricBar label="Memory" value={latestMetric.mem_pct} kind="memory" />
                <MetricBar label="Disk" value={latestMetric.disk_pct} kind="disk" />
                <div className="health-facts"><span>Network <strong>{latestMetric.network_latency_ms == null ? '—' : `${latestMetric.network_latency_ms.toFixed(0)} ms`}{latestMetric.network_packet_loss_pct == null ? '' : ` · ${latestMetric.network_packet_loss_pct.toFixed(1)}% loss`}</strong></span><span>Processes <strong>{latestMetric.process_count ?? '—'}</strong></span><span>Battery <strong>{latestMetric.battery_pct == null ? '—' : `${latestMetric.battery_pct.toFixed(0)}%`}</strong></span><span>Battery health <strong>{latestMetric.battery_health_pct == null ? '—' : `${latestMetric.battery_health_pct.toFixed(0)}%`}</strong></span><span>Uptime <strong>{formatUptime(latestMetric.uptime_seconds ?? device.uptime_seconds)}</strong></span></div>
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
          <section className="detail-card assignment-card">
            <div className="detail-card-head"><div><h2>Assignment</h2><span className="muted mono">IT ownership record</span></div>{canManageDevice ? <button className="btn btn-ghost btn-xs" onClick={() => void openAssignment()}>{assignment ? 'Transfer' : 'Assign'}</button> : null}</div>
            {assignment ? <><div className="assignment-current"><strong>{assignment.assignment_status === 'shared' ? 'Shared device' : assignment.user_name || assignment.user_email || 'Assigned staff member'}</strong><span className="muted">{assignment.assignment_status} · since {formatWhen(assignment.assigned_at)}</span>{assignment.department ? <span className="muted">{assignment.department}{assignment.team_name ? ` · ${assignment.team_name}` : ''}</span> : null}{assignment.location ? <span className="muted">{assignment.location}</span> : null}</div>{canManageDevice ? <button className="btn btn-ghost btn-sm btn-block" onClick={() => void returnAssignment()} disabled={assignmentBusy}>Mark returned</button> : null}</> : <div className="detail-empty">Unassigned. Assign a primary user, shared pool, or temporary owner.</div>}
            {assignmentHistory.length > 0 ? <details className="assignment-history"><summary>Assignment history ({assignmentHistory.length})</summary><div>{assignmentHistory.map((item) => <div key={item.id} className="assignment-history-row"><strong>{item.assignment_status === 'shared' ? 'Shared device' : item.user_name || item.user_email || 'Unassigned'}</strong><span>{formatWhen(item.assigned_at)}{item.returned_at ? ` → ${formatWhen(item.returned_at)}` : ' · current'}</span></div>)}</div></details> : null}
          </section>
          <section className="detail-card">
            <div className="detail-card-head"><h2>Inventory</h2></div>
            <dl className="inventory-list">
              <div><dt>Hostname</dt><dd>{device.hostname || '—'}</dd></div>
              <div><dt>Device type</dt><dd>{(device.device_type ?? 'workstation').replace('_', ' ')}</dd></div>
              <div><dt>Operating system</dt><dd>{device.os || '—'} {device.os_version}</dd></div>
              <div><dt>Architecture</dt><dd>{device.arch || '—'}</dd></div>
              <div><dt>IP address</dt><dd className="mono">{device.ip_address || '—'}</dd></div>
              <div><dt>Agent version</dt><dd className="mono">{device.agent_version || '—'}</dd></div>
              <div><dt>Power / battery</dt><dd>{device.power_source || '—'}{device.battery_pct == null ? '' : ` · ${Number(device.battery_pct).toFixed(0)}%`}{device.battery_health_pct == null ? '' : ` · health ${Number(device.battery_health_pct).toFixed(0)}%`}</dd></div>
              <div><dt>Uptime</dt><dd>{formatUptime(device.uptime_seconds)}</dd></div>
              <div><dt>Inventory updated</dt><dd>{device.last_inventory_at ? formatWhen(device.last_inventory_at) : '—'}</dd></div>
              <div><dt>Asset tag</dt><dd className="mono">{assetIdentity?.tag || 'Not tagged'}</dd></div>
            </dl>
            {assetIdentity?.qr_payload ? <div className="asset-qr-mini"><MfaQrCode value={assetIdentity.qr_payload} /></div> : null}
          </section>

          <section className="detail-card">
            <div className="detail-card-head"><h2>Device details</h2></div>
            <form onSubmit={saveMetadata}>
              <Field label="Display name">
                <input className="field-input" value={name} onChange={(event) => setName(event.target.value)} required />
              </Field>
              <Field label="Device type">
                <select className="field-input" value={deviceType} onChange={(event) => setDeviceType(event.target.value as DeviceType)}>
                  <option value="laptop">Laptop</option><option value="workstation">Workstation</option><option value="server">Server</option><option value="network_device">Network device</option><option value="mobile">Mobile</option><option value="other">Other</option>
                </select>
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

      <Modal open={assignmentOpen} onClose={() => { if (!assignmentBusy) setAssignmentOpen(false) }} title={assignment ? 'Transfer device' : 'Assign device'} width={620} footer={<><button type="button" className="btn btn-ghost" onClick={() => setAssignmentOpen(false)} disabled={assignmentBusy}>Cancel</button><button type="submit" form="assignment-form" className="btn btn-primary" disabled={assignmentBusy || (assignmentStatus !== 'shared' && !assignmentUserId)}>{assignmentBusy ? 'Saving…' : assignment ? 'Save transfer' : 'Assign device'}</button></>}>
        <form id="assignment-form" onSubmit={(event) => void saveAssignment(event)}>
          <p className="modal-description">Keep the assignment record aligned with the physical device. Transfers close the previous record and preserve it in the history.</p>
          <div className="form-row"><Field label="Assignment type"><select className="field-input" value={assignmentStatus} onChange={(event) => { const value = event.target.value as 'assigned' | 'shared' | 'temporary'; setAssignmentStatus(value); if (value === 'shared') setAssignmentUserId('') }}><option value="assigned">Primary user</option><option value="temporary">Temporary replacement</option><option value="shared">Shared pool / kiosk</option></select></Field><Field label="Staff member"><select className="field-input" value={assignmentUserId} onChange={(event) => setAssignmentUserId(event.target.value)} disabled={assignmentStatus === 'shared'}><option value="">{assignmentStatus === 'shared' ? 'Shared device' : 'Select staff member'}</option>{assignmentMembers.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.email}</option>)}</select></Field></div>
          <div className="form-row"><Field label="Department"><input className="field-input" value={assignmentDepartment} onChange={(event) => setAssignmentDepartment(event.target.value)} placeholder="Finance" /></Field><Field label="Team"><select className="field-input" value={assignmentTeamId} onChange={(event) => setAssignmentTeamId(event.target.value)}><option value="">No team</option>{assignmentTeams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field></div>
          <div className="form-row"><Field label="Location"><input className="field-input" value={assignmentLocation} onChange={(event) => setAssignmentLocation(event.target.value)} placeholder="Lagos office" /></Field><Field label="Expected return" hint="Optional"><input className="field-input" type="datetime-local" value={expectedReturnAt} onChange={(event) => setExpectedReturnAt(event.target.value)} /></Field></div>
          <Field label="Reason"><input className="field-input" value={assignmentReason} onChange={(event) => setAssignmentReason(event.target.value)} placeholder="New starter, loaner, transfer…" /></Field>
          <Field label="Notes"><textarea className="field-input" rows={3} value={assignmentNotes} onChange={(event) => setAssignmentNotes(event.target.value)} placeholder="Condition, accessories, or return instructions…" /></Field>
        </form>
      </Modal>
    </Shell>
  )
}
