import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { listDeviceGroups, type DeviceGroup } from '../lib/devices.js'
import {
  createMonitoringRule, deleteMonitoringRule, listMonitoringRules, toggleMonitoringRule, updateMonitoringRule,
  type MonitoringMetric, type MonitoringOperator, type MonitoringRule, type MonitoringSeverity,
} from '../lib/monitoring.js'

const METRICS: Array<{ value: MonitoringMetric; label: string }> = [
  { value: 'cpu_pct', label: 'CPU usage' },
  { value: 'mem_pct', label: 'Memory usage' },
  { value: 'disk_pct', label: 'Disk usage' },
]
const OPERATORS: Array<{ value: MonitoringOperator; label: string }> = [
  { value: 'gte', label: 'at least' },
  { value: 'gt', label: 'above' },
  { value: 'lte', label: 'at most' },
  { value: 'lt', label: 'below' },
  { value: 'eq', label: 'equals' },
  { value: 'neq', label: 'does not equal' },
]

interface FormState {
  name: string
  metric: MonitoringMetric
  op: MonitoringOperator
  value: string
  severity: MonitoringSeverity
  message: string
  createTicket: boolean
  ticketPriority: 'p1' | 'p2' | 'p3' | 'p4'
  groupId: string
}
const EMPTY: FormState = {
  name: '', metric: 'disk_pct', op: 'gte', value: '85', severity: 'warning', message: '',
  createTicket: true, ticketPriority: 'p3', groupId: '',
}

export default function MonitoringPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('monitoring.manage')))
  const [rules, setRules] = useState<MonitoringRule[] | null>(null)
  const [groups, setGroups] = useState<DeviceGroup[]>([])
  const [form, setForm] = useState<FormState>(EMPTY)
  const [editing, setEditing] = useState<MonitoringRule | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setRules((await listMonitoringRules()).rules)
      setGroups((await listDeviceGroups()).groups)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load monitoring rules')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY)
    setError(null)
    setModalOpen(true)
  }

  const openEdit = (rule: MonitoringRule) => {
    setEditing(rule)
    setForm({
      name: rule.name, metric: rule.metric, op: rule.condition.op, value: String(rule.condition.value),
      severity: rule.action.severity, message: rule.action.message ?? '', createTicket: rule.action.createTicket,
      ticketPriority: rule.action.ticketPriority, groupId: rule.group_id ?? '',
    })
    setError(null)
    setModalOpen(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !form.name.trim()) return
    setBusy(true); setError(null); setNotice(null)
    const payload = {
      name: form.name.trim(), metric: form.metric, condition: { op: form.op, value: Number(form.value) },
      action: { severity: form.severity, message: form.message.trim() || undefined, createTicket: form.createTicket, ticketPriority: form.ticketPriority },
      ...(form.groupId ? { groupId: form.groupId } : {}),
    }
    try {
      if (editing) {
        await updateMonitoringRule(editing.id, payload)
        setNotice('Monitoring rule updated.')
      } else {
        await createMonitoringRule(payload)
        setNotice('Monitoring rule created.')
      }
      setModalOpen(false)
      setEditing(null); setForm(EMPTY); await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save monitoring rule')
    } finally { setBusy(false) }
  }

  async function toggle(rule: MonitoringRule) {
    try {
      await toggleMonitoringRule(rule.id, !rule.enabled)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed')
    }
  }

  async function remove(rule: MonitoringRule) {
    if (!confirm(`Delete monitoring rule "${rule.name}"?`)) return
    try {
      await deleteMonitoringRule(rule.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete rule')
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Endpoint monitoring"
        subtitle="Threshold rules that raise deduplicated alerts and can auto-create tickets."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}>New rule</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Panel title="Rules" empty={rules !== null && rules.length === 0}>
        {rules === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading rules…</div>
        ) : (
          <ul className="channel-list">
            {rules.map((rule) => (
              <li key={rule.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{rule.name} {!rule.enabled ? <span className="muted">(disabled)</span> : null}</span>
                  <span className="channel-meta mono">{rule.metric} {rule.condition.op} {rule.condition.value}% · {rule.group_name ?? 'all devices'} · {rule.open_alerts ?? 0} open alerts</span>
                  <span className="channel-meta">{rule.action.createTicket ? `creates ${rule.action.ticketPriority.toUpperCase()} ticket` : 'alert only'}</span>
                </div>
                {canManage ? (
                  <div className="channel-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => void toggle(rule)}>{rule.enabled ? 'Disable' : 'Enable'}</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(rule)}>Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void remove(rule)}>Delete</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) { setModalOpen(false); setEditing(null); setForm(EMPTY) } }}
        title={editing ? 'Edit monitoring rule' : 'New monitoring rule'}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setModalOpen(false); setEditing(null); setForm(EMPTY) }} disabled={busy}>Cancel</button>
            <button type="submit" form="monitoring-form" className="btn btn-primary" disabled={busy || !form.name.trim()}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create rule'}
            </button>
          </>
        }
      >
        <form id="monitoring-form" onSubmit={(e) => void submit(e)}>
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} required autoFocus />
          </Field>
          <div className="form-row">
            <Field label="Metric">
              <select className="field-input" value={form.metric} onChange={(e) => setForm({ ...form, metric: e.target.value as MonitoringMetric })}>
                {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="Threshold">
              <div className="form-row">
                <select className="field-input" value={form.op} onChange={(e) => setForm({ ...form, op: e.target.value as MonitoringOperator })}>
                  {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input className="field-input mono" type="number" min="0" max="100" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} required />
              </div>
            </Field>
          </div>
          <Field label="Scope">
            <select className="field-input" value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })}>
              <option value="">All devices</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </Field>
          <div className="form-row">
            <Field label="Severity">
              <select className="field-input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value as MonitoringSeverity })}>
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </Field>
            <Field label="Ticket priority">
              <select className="field-input" value={form.ticketPriority} onChange={(e) => setForm({ ...form, ticketPriority: e.target.value as FormState['ticketPriority'] })}>
                <option value="p1">P1</option>
                <option value="p2">P2</option>
                <option value="p3">P3</option>
                <option value="p4">P4</option>
              </select>
            </Field>
          </div>
          <Field label="Alert message" hint="Optional. Supports {{device}}, {{metric}}, {{value}}, and {{rule}}.">
            <input className="field-input" value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} maxLength={500} />
          </Field>
          <label className="checkbox-field">
            <input type="checkbox" checked={form.createTicket} onChange={(e) => setForm({ ...form, createTicket: e.target.checked })} />
            <span className="field-label">Create a ticket when this rule matches</span>
          </label>
        </form>
      </Modal>
    </Shell>
  )
}
