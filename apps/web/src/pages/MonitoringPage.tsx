import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel, useConfirm } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import AvailabilityPoliciesPanel from '../components/AvailabilityPoliciesPanel.js'
import { listDeviceGroups, type DeviceGroup } from '../lib/devices.js'
import { listTeams, type Team } from '../lib/tickets.js'
import { api } from '../lib/api.js'
import {
  acknowledgeDeviceAlert, createMonitoringRule, deleteMonitoringRule, getMonitoringOverview, listMonitoringBusinessHours,
  listMonitoringRules, snoozeDeviceAlert, toggleMonitoringRule, updateMonitoringRule,
  type DeviceType, type MonitoringAlert, type MonitoringBusinessHours, type MonitoringMetric, type MonitoringOperator,
  type MonitoringOverview, type MonitoringRule, type MonitoringSeverity,
} from '../lib/monitoring.js'

const METRICS: Array<{ value: MonitoringMetric; label: string; unit: string; max?: number; step?: number; text?: boolean }> = [
  { value: 'cpu_pct', label: 'CPU usage', unit: '%', max: 100, step: 1 },
  { value: 'mem_pct', label: 'Memory usage', unit: '%', max: 100, step: 1 },
  { value: 'disk_pct', label: 'Disk usage', unit: '%', max: 100, step: 1 },
  { value: 'battery_pct', label: 'Battery level', unit: '%', max: 100, step: 1 },
  { value: 'battery_health_pct', label: 'Battery health', unit: '%', max: 100, step: 1 },
  { value: 'network_latency_ms', label: 'Network latency', unit: 'ms', max: 60000, step: 1 },
  { value: 'uptime_seconds', label: 'Uptime', unit: 'seconds', max: 2000000000, step: 60 },
  { value: 'process_count', label: 'Process count', unit: 'processes', max: 1000000, step: 1 },
  { value: 'heartbeat_age_seconds', label: 'Heartbeat age', unit: 'seconds', max: 2000000000, step: 60 },
  { value: 'service_state', label: 'Service state', unit: 'state', text: true },
]
const DEVICE_TYPES: Array<{ value: DeviceType | ''; label: string }> = [
  { value: '', label: 'All device types' }, { value: 'laptop', label: 'Laptop' }, { value: 'workstation', label: 'Workstation' },
  { value: 'server', label: 'Server' }, { value: 'network_device', label: 'Network device' }, { value: 'mobile', label: 'Mobile' }, { value: 'other', label: 'Other' },
]
const OPERATORS: Array<{ value: MonitoringOperator; label: string }> = [
  { value: 'gte', label: 'at least' }, { value: 'gt', label: 'above' }, { value: 'lte', label: 'at most' },
  { value: 'lt', label: 'below' }, { value: 'eq', label: 'equals' }, { value: 'neq', label: 'does not equal' }, { value: 'contains', label: 'contains' },
]
interface FormState {
  name: string; metric: MonitoringMetric; op: MonitoringOperator; value: string; serviceName: string; deviceType: DeviceType | '';
  groupId: string; businessHoursId: string; maintenanceStart: string; maintenanceEnd: string; minDurationSeconds: string;
  severity: MonitoringSeverity; message: string; createTicket: boolean; ticketPriority: 'p1' | 'p2' | 'p3' | 'p4'; teamId: string; escalationAfterMinutes: string;
}
const EMPTY: FormState = {
  name: '', metric: 'disk_pct', op: 'gte', value: '85', serviceName: '', deviceType: '', groupId: '', businessHoursId: '',
  maintenanceStart: '', maintenanceEnd: '', minDurationSeconds: '0', severity: 'warning', message: '', createTicket: true,
  ticketPriority: 'p3', teamId: '', escalationAfterMinutes: '',
}

function metricDefinition(metric: MonitoringMetric) { return METRICS.find((item) => item.value === metric) ?? METRICS[0] }
function formatMetric(metric: MonitoringMetric, value: number | string): string {
  if (metric === 'uptime_seconds' || metric === 'heartbeat_age_seconds') {
    const seconds = Number(value); const days = Math.floor(seconds / 86400); const hours = Math.floor((seconds % 86400) / 3600)
    return `${seconds} seconds${days ? ` (${days}d ${hours}h)` : ''}`
  }
  return `${value} ${metricDefinition(metric).unit}`
}

export default function MonitoringPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('monitoring.manage')))
  const confirm = useConfirm()
  const [overview, setOverview] = useState<MonitoringOverview | null>(null)
  const [rules, setRules] = useState<MonitoringRule[] | null>(null)
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([])
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [businessHours, setBusinessHours] = useState<MonitoringBusinessHours[]>([])
  const [form, setForm] = useState<FormState>(EMPTY)
  const [editing, setEditing] = useState<MonitoringRule | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextOverview, nextRules, nextAlerts, nextGroups, nextTeams, nextHours] = await Promise.all([
        getMonitoringOverview(), listMonitoringRules(), api<{ alerts: MonitoringAlert[] }>('/device-alerts?open=true'), listDeviceGroups(), listTeams(), listMonitoringBusinessHours(),
      ])
      setOverview(nextOverview); setRules(nextRules.rules); setAlerts(nextAlerts.alerts); setGroups(nextGroups.groups); setTeams(nextTeams.teams); setBusinessHours(nextHours.businessHours)
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load monitoring workspace') }
  }, [])
  useEffect(() => { void load() }, [load])

  const openCreate = () => { setEditing(null); setForm(EMPTY); setError(null); setModalOpen(true) }
  const openEdit = (rule: MonitoringRule) => {
    const firstWindow = rule.maintenance_windows?.[0]
    const levels = rule.action.escalation?.levels ?? []
    setEditing(rule)
    setForm({
      name: rule.name, metric: rule.metric, op: rule.condition.op, value: String(rule.condition.value), serviceName: rule.condition.serviceName ?? '',
      deviceType: rule.device_type ?? '', groupId: rule.group_id ?? '', businessHoursId: rule.business_hours_id ?? '',
      maintenanceStart: firstWindow?.start?.slice(0, 16) ?? '', maintenanceEnd: firstWindow?.end?.slice(0, 16) ?? '', minDurationSeconds: String(rule.min_duration_seconds ?? 0),
      severity: rule.action.severity, message: rule.action.message ?? '', createTicket: rule.action.createTicket, ticketPriority: rule.action.ticketPriority,
      teamId: rule.action.routing?.teamId ?? '', escalationAfterMinutes: levels[0]?.afterMinutes ? String(levels[0].afterMinutes) : '',
    })
    setError(null); setModalOpen(true)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy || !form.name.trim()) return
    setBusy(true); setError(null); setNotice(null)
    const definition = metricDefinition(form.metric)
    const parsedValue = definition.text ? form.value.trim() : Number(form.value)
    const maintenanceWindows = form.maintenanceStart && form.maintenanceEnd ? [{ start: new Date(form.maintenanceStart).toISOString(), end: new Date(form.maintenanceEnd).toISOString() }] : []
    const payload = {
      name: form.name.trim(), metric: form.metric, condition: { op: form.op, value: parsedValue, ...(form.metric === 'service_state' && form.serviceName.trim() ? { serviceName: form.serviceName.trim() } : {}) },
      deviceType: form.deviceType || undefined, groupId: form.groupId || undefined, businessHoursId: form.businessHoursId || null, maintenanceWindows,
      minDurationSeconds: Number(form.minDurationSeconds) || 0,
      action: {
        severity: form.severity, message: form.message.trim() || undefined, createTicket: form.createTicket, ticketPriority: form.ticketPriority,
        routing: form.teamId ? { teamId: form.teamId } : {},
        escalation: form.escalationAfterMinutes ? { levels: [{ afterMinutes: Number(form.escalationAfterMinutes), severity: 'critical' as const, routing: form.teamId ? { teamId: form.teamId } : {} }] } : { levels: [] },
      },
    }
    try {
      if (editing) { await updateMonitoringRule(editing.id, payload); setNotice('Monitoring rule updated.') }
      else { await createMonitoringRule(payload); setNotice('Monitoring rule created.') }
      setModalOpen(false); setEditing(null); setForm(EMPTY); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save monitoring rule') }
    finally { setBusy(false) }
  }
  const toggle = async (rule: MonitoringRule) => { try { await toggleMonitoringRule(rule.id, !rule.enabled); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Toggle failed') } }
  const remove = async (rule: MonitoringRule) => { if (!await confirm(`Delete monitoring rule “${rule.name}”?`, { title: 'Delete monitoring rule', confirmLabel: 'Delete rule', destructive: true })) return; try { await deleteMonitoringRule(rule.id); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete rule') } }
  const acknowledge = async (id: string) => { try { await acknowledgeDeviceAlert(id); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not acknowledge alert') } }
  const snooze = async (id: string) => { try { await snoozeDeviceAlert(id, 60); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not snooze alert') } }

  const health = overview?.health
  return <Shell>
    <PageHeader title="Endpoint monitoring" subtitle="Fleet health, actionable alerts, and policies that respect device context and operating schedules." actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}>New rule</button> : undefined} />
    {error ? <Alert kind="error">{error}</Alert> : null}{notice ? <Alert kind="info">{notice}</Alert> : null}

    <div className="stat-row monitoring-stat-row">
      <div className="stat-card"><span className="etch">Managed endpoints</span><strong>{overview?.devices.reduce((sum, item) => sum + item.total, 0) ?? '—'}</strong><small>{overview?.devices.reduce((sum, item) => sum + item.online, 0) ?? '—'} online now</small></div>
      <div className="stat-card"><span className="etch">Open alerts</span><strong>{overview?.alerts.reduce((sum, item) => sum + item.total, 0) ?? '—'}</strong><small>{overview?.alerts.reduce((sum, item) => sum + item.unacknowledged, 0) ?? '—'} need acknowledgement</small></div>
      <div className="stat-card"><span className="etch">Average CPU</span><strong>{health?.cpu_pct == null ? '—' : `${health.cpu_pct}%`}</strong><small>latest fleet sample</small></div>
      <div className="stat-card"><span className="etch">Average latency</span><strong>{health?.network_latency_ms == null ? '—' : `${health.network_latency_ms} ms`}</strong><small>API round-trip</small></div>
    </div>

    <AvailabilityPoliciesPanel />

    <div className="monitoring-overview-grid">
      <Panel title="Fleet by device type" subtitle="Different endpoint classes can use different policies.">
        <div className="monitoring-type-list">{overview?.devices.map((item) => <div key={item.device_type} className="monitoring-type-row"><span>{item.device_type.replace('_', ' ')}</span><strong>{item.online}/{item.total}</strong><span className="muted">online</span></div>) ?? <span className="etch">Loading…</span>}</div>
      </Panel>
      <Panel title="30-day health trend" subtitle="Average CPU, memory, and disk from reported telemetry.">
        <div className="monitoring-trend">{overview?.trend.slice(-14).map((point) => <div key={point.day} className="monitoring-trend-day" title={`${point.day}: CPU ${point.cpu_pct}% · memory ${point.mem_pct}% · disk ${point.disk_pct}%`}><i style={{ height: `${Math.max(4, point.cpu_pct)}%` }} /><i style={{ height: `${Math.max(4, point.mem_pct)}%` }} /><i style={{ height: `${Math.max(4, point.disk_pct)}%` }} /></div>) ?? <span className="etch">Loading…</span>}</div>
      </Panel>
    </div>

    <Panel title="Active alerts" subtitle="Acknowledge noise, snooze maintenance work, or follow the linked ticket." empty={alerts.length === 0}>
      <div className="device-alert-list">{alerts.map((alert) => <div key={alert.id} className="device-alert-row"><span className={`alert-severity severity-${alert.severity}`} /><div className="device-alert-main"><strong>{alert.message}</strong><span className="muted mono">{alert.severity} · {new Date(alert.created_at).toLocaleString()}{alert.acknowledged_at ? ' · acknowledged' : ''}{alert.snoozed_until ? ` · snoozed until ${new Date(alert.snoozed_until).toLocaleString()}` : ''}</span></div>{alert.ticket_number ? <span className="mono">#{alert.ticket_number}</span> : null}{canManage && !alert.acknowledged_at ? <button className="btn btn-ghost btn-sm" onClick={() => void acknowledge(alert.id)}>Acknowledge</button> : null}{canManage ? <button className="btn btn-ghost btn-sm" onClick={() => void snooze(alert.id)}>Snooze 1h</button> : null}</div>)}</div>
    </Panel>

    <Panel title="Rules" subtitle="Rules are evaluated after telemetry is safely stored. A failed action cannot stop endpoint reporting." empty={rules !== null && rules.length === 0}>
      {rules === null ? <div className="etch" style={{ padding: 24 }}>Loading rules…</div> : <ul className="channel-list">{rules.map((rule) => <li key={rule.id} className="channel-card"><div className="channel-main"><span className="channel-name">{rule.name} {!rule.enabled ? <span className="muted">(disabled)</span> : null}</span><span className="channel-meta mono">{rule.metric} {rule.condition.op} {formatMetric(rule.metric, rule.condition.value)} · {rule.device_type ?? 'all types'} · {rule.group_name ?? 'all devices'}</span><span className="channel-meta">{rule.action.createTicket ? `creates ${rule.action.ticketPriority.toUpperCase()} ticket` : 'alert only'}{rule.min_duration_seconds ? ` · sustained ${rule.min_duration_seconds}s` : ''}{rule.action.escalation?.levels?.length ? ` · escalates after ${rule.action.escalation.levels[0].afterMinutes}m` : ''}</span></div>{canManage ? <div className="channel-actions"><button className="btn btn-ghost btn-sm" onClick={() => void toggle(rule)}>{rule.enabled ? 'Disable' : 'Enable'}</button><button className="btn btn-ghost btn-sm" onClick={() => openEdit(rule)}>Edit</button><button className="btn btn-ghost btn-sm" onClick={() => void remove(rule)}>Delete</button></div> : null}</li>)}</ul>}
    </Panel>

    <Modal open={modalOpen} onClose={() => { if (!busy) { setModalOpen(false); setEditing(null); setForm(EMPTY) } }} title={editing ? 'Edit monitoring rule' : 'New monitoring rule'}>
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Name"><input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required autoFocus /></Field>
        <div className="form-row"><Field label="Metric"><select className="field-input" value={form.metric} onChange={(e) => { const metric = e.target.value as MonitoringMetric; setForm({ ...form, metric, value: metric === 'battery_pct' || metric === 'battery_health_pct' ? '20' : metric === 'network_latency_ms' ? '250' : metric === 'uptime_seconds' ? '2592000' : metric === 'heartbeat_age_seconds' ? '600' : metric === 'process_count' ? '300' : metric.endsWith('_pct') ? '85' : metric === 'service_state' ? 'running' : form.value }) }}>{METRICS.map((item) => <option key={item.value} value={item.value}>{item.label} ({item.unit})</option>)}</select></Field><Field label={`Condition (${metricDefinition(form.metric).unit})`}><div className="form-row"><select className="field-input" value={form.op} onChange={(e) => setForm({ ...form, op: e.target.value as MonitoringOperator })}>{OPERATORS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{metricDefinition(form.metric).text ? <input className="field-input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required /> : <input className="field-input mono" type="number" min="0" max={metricDefinition(form.metric).max} step={metricDefinition(form.metric).step} value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />}</div></Field></div>
        {form.metric === 'service_state' ? <Field label="Service name" hint="The agent reports service states by name; use a stable service identifier."><input className="field-input mono" value={form.serviceName} onChange={(e) => setForm({ ...form, serviceName: e.target.value })} placeholder="Spooler" required /></Field> : null}
        <div className="form-row"><Field label="Device type"><select className="field-input" value={form.deviceType} onChange={(e) => setForm({ ...form, deviceType: e.target.value as FormState['deviceType'] })}>{DEVICE_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field><Field label="Device group"><select className="field-input" value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })}><option value="">All devices</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field></div>
        <div className="form-row"><Field label="Suppress outside"><select className="field-input" value={form.businessHoursId} onChange={(e) => setForm({ ...form, businessHoursId: e.target.value })}><option value="">Always evaluate</option>{businessHours.map((hours) => <option key={hours.id} value={hours.id}>{hours.name}</option>)}</select></Field><Field label="Sustained for (seconds)" hint="Prevents short spikes from opening alerts."><input className="field-input" type="number" min="0" max="86400" step="60" value={form.minDurationSeconds} onChange={(e) => setForm({ ...form, minDurationSeconds: e.target.value })} /></Field></div>
        <div className="form-row"><Field label="Maintenance starts"><input className="field-input" type="datetime-local" value={form.maintenanceStart} onChange={(e) => setForm({ ...form, maintenanceStart: e.target.value })} /></Field><Field label="Maintenance ends"><input className="field-input" type="datetime-local" value={form.maintenanceEnd} onChange={(e) => setForm({ ...form, maintenanceEnd: e.target.value })} /></Field></div>
        <div className="form-row"><Field label="Severity"><select className="field-input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as MonitoringSeverity })}><option value="info">Info</option><option value="warning">Warning</option><option value="critical">Critical</option></select></Field><Field label="Ticket priority"><select className="field-input" value={form.ticketPriority} onChange={(e) => setForm({ ...form, ticketPriority: e.target.value as FormState['ticketPriority'] })}><option value="p1">P1</option><option value="p2">P2</option><option value="p3">P3</option><option value="p4">P4</option></select></Field></div>
        <div className="form-row"><Field label="Route to team"><select className="field-input" value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}><option value="">Organization fallback</option>{teams.filter((team) => team.accepts_tickets !== false).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select></Field><Field label="Escalate after (minutes)" hint="Escalates to the selected team at critical severity."><input className="field-input" type="number" min="1" max="43200" value={form.escalationAfterMinutes} onChange={(e) => setForm({ ...form, escalationAfterMinutes: e.target.value })} /></Field></div>
        <Field label="Alert message" hint="Supports {{device}}, {{metric}}, {{value}}, and {{rule}}."><input className="field-input" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} maxLength={500} /></Field>
        <label className="checkbox-field"><input type="checkbox" checked={form.createTicket} onChange={(e) => setForm({ ...form, createTicket: e.target.checked })} /><span className="field-label">Create a ticket when this rule matches</span></label>
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => { setModalOpen(false); setEditing(null); setForm(EMPTY) }} disabled={busy}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}</button></div>
      </form>
    </Modal>
  </Shell>
}
