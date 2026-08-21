import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, Field, Modal, Panel, SubmitButton, useConfirm } from './ui.js'
import { Icon } from './Icons.js'
import { useAuth } from '../lib/auth.js'
import { listDeviceGroups, type DeviceGroup } from '../lib/devices.js'
import {
  createAvailabilityPolicy, deleteAvailabilityPolicy, listAvailabilityPolicies, listMonitoringBusinessHours, updateAvailabilityPolicy,
  type AvailabilityPolicy, type AvailabilityPolicyInput, type MonitoringBusinessHours, type DeviceType,
} from '../lib/monitoring.js'

const TYPES: Array<{ value: DeviceType | ''; label: string }> = [
  { value: '', label: 'All device types' }, { value: 'laptop', label: 'Laptop' }, { value: 'workstation', label: 'Workstation' },
  { value: 'server', label: 'Server' }, { value: 'network_device', label: 'Network device' }, { value: 'mobile', label: 'Mobile' }, { value: 'other', label: 'Other' },
]
const POWER_STATES = ['battery', 'unknown', 'ac'] as const

type FormState = {
  name: string; groupId: string; deviceType: DeviceType | ''; threshold: string; grace: string; alertDelay: string; ticketDelay: string;
  mode: 'alert' | 'ticket'; timezone: string; businessHoursId: string; maintenanceStart: string; maintenanceEnd: string;
  suppressPowerStates: string[]; critical: boolean; recovery: boolean; priority: string;
}

const initialForm = (): FormState => ({
  name: '', groupId: '', deviceType: '', threshold: '30', grace: '10', alertDelay: '5', ticketDelay: '30', mode: 'alert',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', businessHoursId: '', maintenanceStart: '', maintenanceEnd: '',
  suppressPowerStates: ['battery'], critical: false, recovery: true, priority: '0',
})

function formFromPolicy(policy: AvailabilityPolicy): FormState {
  const window = policy.maintenance_windows?.[0]
  return {
    name: policy.name, groupId: policy.group_id ?? '', deviceType: policy.device_type ?? '', threshold: String(policy.offline_threshold_minutes),
    grace: String(policy.grace_period_minutes), alertDelay: String(policy.alert_delay_minutes), ticketDelay: String(policy.ticket_delay_minutes),
    mode: policy.ticket_mode, timezone: policy.timezone, businessHoursId: policy.business_hours_id ?? '',
    maintenanceStart: window?.start?.slice(0, 16) ?? '', maintenanceEnd: window?.end?.slice(0, 16) ?? '',
    suppressPowerStates: policy.suppress_power_states ?? [], critical: policy.critical_override, recovery: policy.recovery_notifications, priority: String(policy.priority),
  }
}

function policySummary(policy: AvailabilityPolicy): string {
  const scope = [policy.group_name ?? 'All groups', policy.device_type ?? 'all types'].join(' · ')
  const action = policy.ticket_mode === 'ticket' ? `ticket after ${policy.ticket_delay_minutes}m` : 'alert only'
  return `${scope} · offline after ${policy.offline_threshold_minutes}m · ${action}`
}

export default function AvailabilityPoliciesPanel() {
  const canManage = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('monitoring.manage')))
  const confirm = useConfirm()
  const [policies, setPolicies] = useState<AvailabilityPolicy[]>([])
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [hours, setHours] = useState<MonitoringBusinessHours[]>([])
  const [form, setForm] = useState<FormState>(initialForm)
  const [editing, setEditing] = useState<AvailabilityPolicy | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [policyResponse, groupResponse, hoursResponse] = await Promise.all([listAvailabilityPolicies(), listDeviceGroups(), listMonitoringBusinessHours()])
      setPolicies(policyResponse.policies); setGroups(groupResponse.groups); setHours(hoursResponse.businessHours)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load availability policies') }
  }, [])
  useEffect(() => { void load() }, [load])

  const close = () => { if (!busy) { setOpen(false); setEditing(null); setForm(initialForm()) } }
  const startCreate = () => { setEditing(null); setForm(initialForm()); setError(null); setOpen(true) }
  const startEdit = (policy: AvailabilityPolicy) => { setEditing(policy); setForm(formFromPolicy(policy)); setError(null); setOpen(true) }
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }))
  const togglePower = (state: string) => set('suppressPowerStates', form.suppressPowerStates.includes(state) ? form.suppressPowerStates.filter((item) => item !== state) : [...form.suppressPowerStates, state])

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    if (form.maintenanceStart && !form.maintenanceEnd) { setError('Add an end time for the maintenance window.'); return }
    if (form.maintenanceEnd && !form.maintenanceStart) { setError('Add a start time for the maintenance window.'); return }
    setBusy(true); setError(null); setNotice(null)
    const maintenanceWindows = form.maintenanceStart && form.maintenanceEnd ? [{ start: new Date(form.maintenanceStart).toISOString(), end: new Date(form.maintenanceEnd).toISOString() }] : []
    const body: AvailabilityPolicyInput = {
      name: form.name.trim(), groupId: form.groupId || null, deviceType: form.deviceType || null, priority: Number(form.priority) || 0,
      offlineThresholdMinutes: Number(form.threshold), gracePeriodMinutes: Number(form.grace), alertDelayMinutes: Number(form.alertDelay),
      ticketDelayMinutes: Number(form.ticketDelay), ticketMode: form.mode, timezone: form.timezone.trim() || 'UTC', businessHoursId: form.businessHoursId || null,
      maintenanceWindows, suppressPowerStates: form.suppressPowerStates as Array<'ac' | 'battery' | 'unknown'>, criticalOverride: form.critical,
      recoveryNotifications: form.recovery, enabled: true,
    }
    try {
      if (editing) { await updateAvailabilityPolicy(editing.id, body); setNotice('Availability policy updated.') }
      else { await createAvailabilityPolicy(body); setNotice('Availability policy created.') }
      close(); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save availability policy') }
    finally { setBusy(false) }
  }

  const remove = async (policy: AvailabilityPolicy) => {
    if (!await confirm(`Delete “${policy.name}”? Devices will fall back to the next matching policy.`, { title: 'Delete availability policy', confirmLabel: 'Delete policy', destructive: true })) return
    try { await deleteAvailabilityPolicy(policy.id); setNotice('Availability policy deleted.'); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete policy') }
  }

  return <Panel title="Device availability policies" subtitle="Choose when a device is considered unavailable, when to alert, and when to open a ticket." actions={canManage ? <button className="btn btn-primary btn-sm" onClick={startCreate}><Icon name="add" size={14} />New policy</button> : undefined}>
    {error ? <Alert kind="error">{error}</Alert> : null}{notice ? <Alert kind="info">{notice}</Alert> : null}
    {policies.length === 0 ? <div className="availability-empty"><Icon name="monitor" size={20} /><div><strong>No custom availability policies</strong><p>The tenant default is used until you add a group or device-class policy.</p></div></div> : <div className="availability-policy-list">{policies.map((policy) => <div className="availability-policy-card" key={policy.id}><div className="availability-policy-main"><div className="availability-policy-title"><strong>{policy.name}</strong>{policy.critical_override ? <span className="badge badge-critical">Critical override</span> : null}{policy.open_alerts ? <span className="badge badge-warning">{policy.open_alerts} open</span> : null}</div><span className="channel-meta">{policySummary(policy)}</span><span className="channel-meta">Grace {policy.grace_period_minutes}m · alert delay {policy.alert_delay_minutes}m · {policy.timezone}{policy.business_hours_name ? ` · ${policy.business_hours_name}` : ''}</span><span className="channel-meta">{policy.suppress_power_states.length ? `Suppresses while ${policy.suppress_power_states.join(', ')}` : 'Power-aware suppression disabled'} · {policy.recovery_notifications ? 'recovery notifications on' : 'recovery notifications off'}</span></div>{canManage ? <div className="availability-policy-actions"><button className="btn btn-ghost btn-sm" onClick={() => startEdit(policy)}><Icon name="edit" size={14} />Edit</button><button className="btn btn-ghost btn-sm" onClick={() => void remove(policy)}><Icon name="delete" size={14} />Delete</button></div> : null}</div>)}</div>}

    <Modal open={open} onClose={close} title={editing ? 'Edit availability policy' : 'New availability policy'}>
      <form onSubmit={(event) => void submit(event)}>
        <Field label="Policy name"><input className="field-input" value={form.name} onChange={(event) => set('name', event.target.value)} placeholder="Laptops after working hours" required autoFocus /></Field>
        <div className="form-row"><Field label="Device group"><select className="field-input" value={form.groupId} onChange={(event) => set('groupId', event.target.value)}><option value="">All groups</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></Field><Field label="Device classification"><select className="field-input" value={form.deviceType} onChange={(event) => set('deviceType', event.target.value as FormState['deviceType'])}>{TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></Field></div>
        <div className="form-row"><Field label="Offline threshold (minutes)"><input className="field-input" type="number" min="1" max="43200" value={form.threshold} onChange={(event) => set('threshold', event.target.value)} required /></Field><Field label="Grace period (minutes)" hint="Useful for sleep, roaming, and brief network loss."><input className="field-input" type="number" min="0" max="10080" value={form.grace} onChange={(event) => set('grace', event.target.value)} required /></Field></div>
        <div className="form-row"><Field label="Alert escalation delay (minutes)"><input className="field-input" type="number" min="0" max="10080" value={form.alertDelay} onChange={(event) => set('alertDelay', event.target.value)} required /></Field><Field label="Ticket escalation delay (minutes)" hint="Measured after the alert is created; ignored for alert-only mode."><input className="field-input" type="number" min="0" max="43200" value={form.ticketDelay} onChange={(event) => set('ticketDelay', event.target.value)} required /></Field></div>
        <div className="form-row"><Field label="Action"><select className="field-input" value={form.mode} onChange={(event) => set('mode', event.target.value as FormState['mode'])}><option value="alert">Alert only</option><option value="ticket">Alert, then create ticket</option></select></Field><Field label="Priority"><input className="field-input" type="number" min="-1000" max="1000" value={form.priority} onChange={(event) => set('priority', event.target.value)} /></Field></div>
        <div className="form-row"><Field label="Timezone" hint="Use an IANA name, e.g. Europe/London."><input className="field-input mono" value={form.timezone} onChange={(event) => set('timezone', event.target.value)} required /></Field><Field label="Suppress outside"><select className="field-input" value={form.businessHoursId} onChange={(event) => set('businessHoursId', event.target.value)}><option value="">Never suppress by schedule</option>{hours.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field></div>
        <div className="form-row"><Field label="Maintenance starts"><input className="field-input" type="datetime-local" value={form.maintenanceStart} onChange={(event) => set('maintenanceStart', event.target.value)} /></Field><Field label="Maintenance ends"><input className="field-input" type="datetime-local" value={form.maintenanceEnd} onChange={(event) => set('maintenanceEnd', event.target.value)} /></Field></div>
        <fieldset className="availability-fieldset"><legend>Power-state suppression</legend><p className="field-hint">Do not raise availability alerts while the endpoint is in one of these states. Critical overrides bypass this suppression.</p>{POWER_STATES.map((state) => <label className="checkbox-field" key={state}><input type="checkbox" checked={form.suppressPowerStates.includes(state)} onChange={() => togglePower(state)} /><span className="field-label">{state === 'ac' ? 'AC power' : state === 'battery' ? 'Battery power' : 'Unknown power state'}</span></label>)}</fieldset>
        <label className="checkbox-field"><input type="checkbox" checked={form.critical} onChange={(event) => set('critical', event.target.checked)} /><span><span className="field-label">Critical-group override</span><small className="field-hint">Ignore working hours, maintenance, and power suppression; raise a critical alert.</small></span></label>
        <label className="checkbox-field"><input type="checkbox" checked={form.recovery} onChange={(event) => set('recovery', event.target.checked)} /><span className="field-label">Notify when the device recovers</span></label>
        <div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button><SubmitButton busy={busy}>{editing ? 'Save changes' : 'Create policy'}</SubmitButton></div>
      </form>
    </Modal>
  </Panel>
}
