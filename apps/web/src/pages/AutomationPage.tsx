import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel, useConfirm } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
import {
  createAutomation, deleteAutomation, listAutomations, toggleAutomation, updateAutomation,
  type Automation, type AutomationAction, type AutomationCondition, type AutomationTrigger,
} from '../lib/automation.js'

const TRIGGERS: AutomationTrigger[] = ['ticket.created', 'ticket.updated', 'device.offline', 'device.low_disk']
const OPS = ['eq', 'neq', 'contains', 'in'] as const

interface CondRow {
  field: string
  op: (typeof OPS)[number]
  value: string
}

interface ActionRow {
  type: string
  value: string
}

interface FormState {
  name: string
  trigger: AutomationTrigger
  enabled: boolean
  conditions: CondRow[]
  actions: ActionRow[]
}

const EMPTY_FORM: FormState = {
  name: '',
  trigger: 'ticket.created',
  enabled: true,
  conditions: [{ field: 'priority', op: 'eq', value: 'p1' }],
  actions: [{ type: 'add_note', value: 'Flagged by automation' }],
}

const ACTION_OPTIONS = [
  { value: 'set_priority', label: 'Set priority', hint: 'p1–p4' },
  { value: 'add_tags', label: 'Add tags', hint: 'comma-separated' },
  { value: 'assign_team', label: 'Assign team', hint: 'team id' },
  { value: 'assign_user', label: 'Assign user', hint: 'user id' },
  { value: 'notify', label: 'Notify role', hint: 'e.g. analyst' },
  { value: 'add_note', label: 'Add internal note', hint: 'note text' },
  { value: 'webhook', label: 'Webhook', hint: 'https://…' },
]

function condRowsToConditions(rows: CondRow[]): { all?: AutomationCondition[] } {
  const all = rows
    .filter((r) => r.field.trim())
    .map((r) => ({ field: r.field.trim(), op: r.op, value: r.value }))
  return { all }
}

function actionRowsToActions(rows: ActionRow[]): AutomationAction[] {
  return rows.filter((r) => r.value.trim()).map((r) => {
    switch (r.type) {
      case 'set_priority': return { type: 'set_priority', priority: r.value.trim() }
      case 'add_tags': return { type: 'add_tags', tags: r.value.split(',').map((t) => t.trim()).filter(Boolean) }
      case 'assign_team': return { type: 'assign_team', team_id: r.value.trim() }
      case 'assign_user': return { type: 'assign_user', user_id: r.value.trim() }
      case 'notify': return { type: 'notify', role: r.value.trim() }
      case 'webhook': return { type: 'webhook', url: r.value.trim() }
      case 'add_note': default: return { type: 'add_note', body: r.value }
    }
  })
}

function describeAction(a: AutomationAction): string {
  switch (a.type) {
    case 'set_priority': return `set priority ${a.priority}`
    case 'add_tags': return `add tags [${a.tags.join(', ')}]`
    case 'assign_team': return 'assign team'
    case 'assign_user': return 'assign user'
    case 'notify': return `notify ${a.role ?? a.user_id ?? ''}`
    case 'add_note': return 'add internal note'
    case 'webhook': return 'webhook'
  }
}

export default function AutomationPage() {
  const canManage = useAuth((s) => s.memberships.some((m) => m.permissions.includes('automation.manage')))
  const [items, setItems] = useState<Automation[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<Automation | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const confirm = useConfirm()

  const load = useCallback(async () => {
    try {
      setItems((await listAutomations()).automations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load automations')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError(null)
    setModalOpen(true)
  }

  const openEdit = (item: Automation) => {
    setEditing(item)
    setForm({
      name: item.name,
      trigger: item.trigger,
      enabled: item.enabled,
      conditions: (item.conditions?.all ?? []).map((c) => ({
        field: c.field,
        op: c.op,
        value: Array.isArray(c.value) ? c.value.join(',') : String(c.value ?? ''),
      })),
      actions: item.actions.map((a) => {
        const v =
          a.type === 'add_tags' ? a.tags.join(', ') :
          a.type === 'set_priority' ? a.priority :
          a.type === 'assign_team' ? a.team_id :
          a.type === 'assign_user' ? a.user_id :
          a.type === 'notify' ? (a.role ?? a.user_id ?? '') :
          a.type === 'webhook' ? a.url : a.body
        return { type: a.type, value: v }
      }),
    })
    setError(null)
    setModalOpen(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const payload = {
        name: form.name,
        conditions: condRowsToConditions(form.conditions),
        actions: actionRowsToActions(form.actions),
      }
      if (editing) {
        await updateAutomation(editing.id, payload)
        setNotice('Automation updated.')
      } else {
        await createAutomation({ ...payload, trigger: form.trigger, enabled: form.enabled })
        setNotice('Automation created.')
      }
      setModalOpen(false)
      setForm(EMPTY_FORM)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function toggle(item: Automation) {
    setError(null)
    try {
      await toggleAutomation(item.id, !item.enabled)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed')
    }
  }

  async function remove(item: Automation) {
    if (!await confirm(`Delete automation “${item.name}”?`, { title: 'Delete automation', confirmLabel: 'Delete', destructive: true })) return
    setError(null)
    try {
      await deleteAutomation(item.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const setCond = (i: number, patch: Partial<CondRow>) =>
    setForm({ ...form, conditions: form.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) })
  const setAction = (i: number, patch: Partial<ActionRow>) =>
    setForm({ ...form, actions: form.actions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)) })

  return (
    <Shell>
      <PageHeader
        title="Automations"
        subtitle="Trigger → condition → action rules, applied atomically."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />New automation</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Panel title="Rules" empty={items !== null && items.length === 0}>
        {items === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading automations…</div>
        ) : (
          <ul className="channel-list">
            {items.map((item) => (
              <li key={item.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{item.name} {item.enabled ? '' : <span className="muted">(disabled)</span>}</span>
                  <span className="channel-meta mono">{item.trigger} · {item.run_count} runs</span>
                  <span className="channel-meta">{item.actions.map(describeAction).join(' → ')}</span>
                </div>
                {canManage ? (
                  <div className="channel-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => void toggle(item)}><Icon name={item.enabled ? 'stop' : 'play'} size={14} />{item.enabled ? 'Disable' : 'Enable'}</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(item)}><Icon name="edit" size={14} />Edit</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => void remove(item)}><Icon name="delete" size={14} />Delete</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) { setModalOpen(false); setEditing(null); setForm(EMPTY_FORM) } }}
        title={editing ? 'Edit automation' : 'New automation'}
        width={640}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => { setModalOpen(false); setEditing(null); setForm(EMPTY_FORM) }} disabled={busy}>Cancel</button>
            <button type="submit" form="automation-form" className="btn btn-primary" disabled={busy || !form.name.trim()}>
              <Icon name="save" size={14} />{busy ? 'Saving…' : editing ? 'Save changes' : 'Create automation'}
            </button>
          </>
        }
      >
        <form id="automation-form" onSubmit={(e) => void handleSubmit(e)}>
          <Field label="Name">
            <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} minLength={1} maxLength={120} required autoFocus />
          </Field>
          <div className="form-row">
            <Field label="Trigger">
              <select className="field-input" value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value as AutomationTrigger })} disabled={!!editing}>
                {TRIGGERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Enabled">
              <input type="checkbox" className="checkbox-field" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            </Field>
          </div>

          <h3 className="channel-title" style={{ marginTop: 20 }}>When (all match)</h3>
          {form.conditions.map((c, i) => (
            <div key={i} className="form-row" style={{ marginBottom: 8 }}>
              <Field label="Field">
                <input className="field-input mono" value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} placeholder="priority" />
              </Field>
              <Field label="Op">
                <select className="field-input" value={c.op} onChange={(e) => setCond(i, { op: e.target.value as CondRow['op'] })}>
                  {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                </select>
              </Field>
              <Field label="Value">
                <input className="field-input mono" value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} placeholder="p1" />
              </Field>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, conditions: [...form.conditions, { field: '', op: 'eq', value: '' }] })}>
            <Icon name="add" size={14} />condition
          </button>

          <h3 className="channel-title" style={{ marginTop: 20 }}>Then (actions)</h3>
          {form.actions.map((a, i) => {
            const opt = ACTION_OPTIONS.find((o) => o.value === a.type)!
            return (
              <div key={i} className="form-row" style={{ marginBottom: 8 }}>
                <Field label="Action">
                  <select className="field-input" value={a.type} onChange={(e) => setAction(i, { type: e.target.value })}>
                    {ACTION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Value" hint={opt.hint}>
                  <input className="field-input mono" value={a.value} onChange={(e) => setAction(i, { value: e.target.value })} placeholder={opt.hint} />
                </Field>
              </div>
            )
          })}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, actions: [...form.actions, { type: 'add_note', value: '' }] })}>
            <Icon name="add" size={14} />action
          </button>
        </form>
      </Modal>
    </Shell>
  )
}
