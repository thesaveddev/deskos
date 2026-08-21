import { useCallback, useEffect, useState } from 'react'
import { Alert, Modal, useConfirm } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icons.js'

/* ── Types ──────────────────────────────────────────────────── */
interface SlaPolicy { id: string; name: string; is_default: boolean; matrix: Record<string, { response: number; resolution: number }> }
interface Category { id: string; name: string; description: string }
interface EscalationPolicy { id: number; name: string; trigger_after_minutes: number; trigger_on_priority: string[]; target_team_id: string | null; auto_assign: boolean; enabled: boolean }
interface Team { id: string; name: string; accepts_tickets?: boolean }
interface Settings {
  ticket_prefix: string; auto_assign_enabled: boolean; auto_close_enabled: boolean; auto_close_after_days: number
  require_description: boolean; allow_attachments: boolean; public_notes_visible: boolean
  default_priority: string; default_type: string
}

type Tab = 'general' | 'sla' | 'categories' | 'escalation'
const PRIO = ['p1', 'p2', 'p3', 'p4']
const TYPES = ['incident', 'service_request', 'question', 'problem', 'change']
const fmt = (m: number) => m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`

/* ── Toggle Switch ──────────────────────────────────────────── */
function Toggle({ checked, onChange, disabled, label, desc }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; desc?: string }) {
  return (
    <label className={`ts-toggle ${disabled ? 'disabled' : ''}`}>
      <div className="ts-toggle-text">
        <span className="ts-toggle-label">{label}</span>
        {desc && <span className="ts-toggle-desc">{desc}</span>}
      </div>
      <div className={`ts-toggle-track ${checked ? 'on' : 'off'}`} onClick={(e) => { e.preventDefault(); if (!disabled) onChange(!checked) }}>
        <div className="ts-toggle-thumb" />
      </div>
    </label>
  )
}

/* ── Main ───────────────────────────────────────────────────── */
export default function TicketSettingsPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('settings.manage')
  const confirm = useConfirm()

  const [tab, setTab] = useState<Tab>('general')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [slaPolicies, setSlaPolicies] = useState<SlaPolicy[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [escalations, setEscalations] = useState<EscalationPolicy[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // SLA form
  const [slaEdit, setSlaEdit] = useState<SlaPolicy | null>(null)
  const [slaName, setSlaName] = useState('')
  const [slaMatrix, setSlaMatrix] = useState<Record<string, { response: number; resolution: number }>>({ p1: { response: 15, resolution: 240 }, p2: { response: 60, resolution: 480 }, p3: { response: 240, resolution: 1440 }, p4: { response: 480, resolution: 2880 } })
  const [showSlaForm, setShowSlaForm] = useState(false)

  // Category form
  const [catEdit, setCatEdit] = useState<Category | null>(null)
  const [catName, setCatName] = useState('')
  const [catDesc, setCatDesc] = useState('')
  const [showCatForm, setShowCatForm] = useState(false)

  // Escalation form
  const [escName, setEscName] = useState('')
  const [escMinutes, setEscMinutes] = useState(60)
  const [escPriorities, setEscPriorities] = useState<string[]>([])
  const [escTeam, setEscTeam] = useState('')
  const [escAutoAssign, setEscAutoAssign] = useState(false)
  const [showEscForm, setShowEscForm] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, sla, cat, esc, t] = await Promise.allSettled([
        api('/tenant/settings') as Promise<{ settings: Settings }>,
        api('/sla-policies') as Promise<{ policies: SlaPolicy[] }>,
        api('/categories') as Promise<{ categories: Category[] }>,
        api('/escalation-policies') as Promise<{ policies: EscalationPolicy[] }>,
        api('/teams') as Promise<{ teams: Team[] }>,
      ])
      if (s.status === 'fulfilled') setSettings(s.value.settings)
      if (sla.status === 'fulfilled') setSlaPolicies(sla.value.policies || [])
      if (cat.status === 'fulfilled') setCategories(cat.value.categories || [])
      if (esc.status === 'fulfilled') setEscalations(esc.value.policies || [])
      if (t.status === 'fulfilled') setTeams(t.value.teams || [])
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load') }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const notify = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  const saveSetting = async (updates: Partial<Settings>) => {
    if (!settings) return
    setBusy(true)
    try {
      const res = await api('/tenant/settings', { method: 'PATCH', body: updates }) as { settings: Settings }
      setSettings(res.settings); notify('Saved')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  // ── SLA ──
  const saveSla = async () => {
    setBusy(true)
    try {
      if (slaEdit) await api(`/sla-policies/${slaEdit.id}`, { method: 'PATCH', body: { name: slaName, matrix: slaMatrix } })
      else await api('/sla-policies', { method: 'POST', body: { name: slaName, matrix: slaMatrix } })
      setShowSlaForm(false); setSlaEdit(null); setSlaName('')
      await load(); notify('SLA policy saved')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteSla = async (id: string) => {
    if (!await confirm('Delete this SLA policy?', { title: 'Delete SLA policy', confirmLabel: 'Delete policy', destructive: true })) return
    try { await api(`/sla-policies/${id}`, { method: 'DELETE' }); await load() } catch { /* */ }
  }

  // ── Category ──
  const saveCat = async () => {
    if (!catName.trim()) return
    setBusy(true)
    try {
      if (catEdit) await api(`/categories/${catEdit.id}`, { method: 'PATCH', body: { name: catName, description: catDesc } })
      else await api('/categories', { method: 'POST', body: { name: catName, description: catDesc } })
      setShowCatForm(false); setCatEdit(null); setCatName(''); setCatDesc('')
      await load(); notify('Category saved')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteCat = async (id: string) => {
    if (!await confirm('Delete this category?', { title: 'Delete ticket category', confirmLabel: 'Delete category', destructive: true })) return
    try { await api(`/categories/${id}`, { method: 'DELETE' }); await load() } catch { /* */ }
  }

  // ── Escalation ──
  const saveEsc = async () => {
    if (!escName.trim()) return
    setBusy(true)
    try {
      await api('/escalation-policies', { method: 'POST', body: { name: escName, trigger_after_minutes: escMinutes, trigger_on_priority: escPriorities, target_team_id: escTeam || null, auto_assign: escAutoAssign } })
      setShowEscForm(false); setEscName(''); setEscMinutes(60); setEscPriorities([]); setEscTeam(''); setEscAutoAssign(false)
      await load(); notify('Escalation policy created')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteEsc = async (id: number) => {
    if (!await confirm('Delete this policy?', { title: 'Delete escalation policy', confirmLabel: 'Delete policy', destructive: true })) return
    try { await api(`/escalation-policies/${id}`, { method: 'DELETE' }); await load() } catch { /* */ }
  }

  if (loading) return <div className="etch" style={{ padding: 24 }}>Loading…</div>

  return (
    <div className="ts-page">
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <div className="ts-tabs">
        {([['general', 'General'], ['sla', 'SLA Policies'], ['categories', 'Categories'], ['escalation', 'Escalation']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} className={`ts-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      {/* ═══ GENERAL ═══ */}
      {tab === 'general' && (
        <div className="ts-sections">
          <section className="ts-section">
            <h3 className="ts-section-title">Ticket defaults</h3>
            <div className="ts-grid-3">
              <div className="ts-field">
                <label className="ts-label">Ticket prefix</label>
                <input className="ts-input" value={settings?.ticket_prefix || 'TKT'} onChange={(e) => saveSetting({ ticket_prefix: e.target.value })} style={{ maxWidth: 100 }} />
                <span className="ts-hint">e.g. TKT-001</span>
              </div>
              <div className="ts-field">
                <label className="ts-label">Default priority</label>
                <select className="ts-input" value={settings?.default_priority || 'p3'} onChange={(e) => saveSetting({ default_priority: e.target.value })}>
                  {PRIO.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
                </select>
              </div>
              <div className="ts-field">
                <label className="ts-label">Default type</label>
                <select className="ts-input" value={settings?.default_type || 'incident'} onChange={(e) => saveSetting({ default_type: e.target.value })}>
                  {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                </select>
              </div>
            </div>
          </section>

          <section className="ts-section">
            <h3 className="ts-section-title">Behaviour</h3>
            <div className="ts-toggles">
              <Toggle label="Require description" desc="Force agents to describe the issue when creating tickets" checked={settings?.require_description ?? true} onChange={(v) => saveSetting({ require_description: v })} disabled={!canManage} />
              <Toggle label="Allow attachments" desc="Enable file uploads on tickets" checked={settings?.allow_attachments ?? true} onChange={(v) => saveSetting({ allow_attachments: v })} disabled={!canManage} />
              <Toggle label="Public notes visible" desc="Show internal notes in the customer portal" checked={settings?.public_notes_visible ?? true} onChange={(v) => saveSetting({ public_notes_visible: v })} disabled={!canManage} />
            </div>
          </section>

          <section className="ts-section">
            <h3 className="ts-section-title">Automation</h3>
            <div className="ts-toggles">
              <Toggle label="Auto-assign tickets" desc="Automatically distribute new tickets to available agents" checked={settings?.auto_assign_enabled ?? false} onChange={(v) => saveSetting({ auto_assign_enabled: v })} disabled={!canManage} />
              <Toggle label="Auto-close resolved tickets" desc="Close tickets after a period of inactivity" checked={settings?.auto_close_enabled ?? false} onChange={(v) => saveSetting({ auto_close_enabled: v })} disabled={!canManage} />
            </div>
            {settings?.auto_close_enabled && (
              <div className="ts-field" style={{ marginTop: '0.75rem', maxWidth: 200 }}>
                <label className="ts-label">Auto-close after (days)</label>
                <input className="ts-input" type="number" min={1} max={90} value={settings?.auto_close_after_days || 7} onChange={(e) => saveSetting({ auto_close_after_days: Number(e.target.value) })} />
              </div>
            )}
          </section>
        </div>
      )}

      {/* ═══ SLA ═══ */}
      {tab === 'sla' && (
        <div className="ts-sections">
          <div className="ts-section-header">
            <p className="ts-section-desc">Define response and resolution time targets per priority level.</p>
            <button className="btn btn-primary btn-sm" onClick={() => { setSlaEdit(null); setSlaName(''); setSlaMatrix({ p1: { response: 15, resolution: 240 }, p2: { response: 60, resolution: 480 }, p3: { response: 240, resolution: 1440 }, p4: { response: 480, resolution: 2880 } }); setShowSlaForm(true) }}><Icon name="add" size={14} />New policy</button>
          </div>

          {slaPolicies.length === 0 && <p className="ts-empty">No SLA policies yet. Create one to get started.</p>}

          {slaPolicies.map((sla) => (
            <div key={sla.id} className="ts-card">
              <div className="ts-card-head">
                <div>
                  <span className="ts-card-name">{sla.name}</span>
                  {sla.is_default && <span className="ts-badge ts-badge-accent">Default</span>}
                </div>
                <div className="ts-card-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => { setSlaEdit(sla); setSlaName(sla.name); setSlaMatrix(sla.matrix); setShowSlaForm(true) }}><Icon name="edit" size={14} />Edit</button>
                  {!sla.is_default && <button className="btn btn-ghost btn-sm btn-danger" onClick={() => void deleteSla(sla.id)}>Delete</button>}
                </div>
              </div>
              <table className="ts-matrix">
                <thead><tr><th>Priority</th><th>Response</th><th>Resolution</th></tr></thead>
                <tbody>
                  {Object.entries(sla.matrix || {}).map(([p, t]) => (
                    <tr key={p}><td className="ts-matrix-prio">{p.toUpperCase()}</td><td>{fmt(t.response)}</td><td>{fmt(t.resolution)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <Modal open={showSlaForm} onClose={() => { if (!busy) { setShowSlaForm(false); setSlaEdit(null) } }} title={`${slaEdit ? 'Edit' : 'New'} SLA Policy`} width={640}>
            <div className="ts-field" style={{ maxWidth: 300, marginBottom: '1rem' }}>
              <label className="ts-label">Name</label>
              <input className="ts-input" value={slaName} onChange={(e) => setSlaName(e.target.value)} placeholder="e.g. Standard SLA" autoFocus />
            </div>
            <table className="ts-matrix ts-matrix-edit">
              <thead><tr><th>Priority</th><th>Response (min)</th><th>Resolution (min)</th></tr></thead>
              <tbody>
                {PRIO.map((p) => (
                  <tr key={p}>
                    <td className="ts-matrix-prio">{p.toUpperCase()}</td>
                    <td><input className="ts-input ts-input-sm" type="number" min={0} value={slaMatrix[p]?.response ?? 0} onChange={(e) => setSlaMatrix((m) => ({ ...m, [p]: { ...m[p], response: Number(e.target.value) } }))} /></td>
                    <td><input className="ts-input ts-input-sm" type="number" min={0} value={slaMatrix[p]?.resolution ?? 0} onChange={(e) => setSlaMatrix((m) => ({ ...m, [p]: { ...m[p], resolution: Number(e.target.value) } }))} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="ts-form-actions" style={{ marginTop: '1rem' }}>
              <button className="btn btn-primary btn-sm" onClick={() => void saveSla()} disabled={busy || !slaName.trim()}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowSlaForm(false); setSlaEdit(null) }}><Icon name="close" size={14} />Cancel</button>
            </div>
          </Modal>
        </div>
      )}

      {/* ═══ CATEGORIES ═══ */}
      {tab === 'categories' && (
        <div className="ts-sections">
          <div className="ts-section-header">
            <p className="ts-section-desc">Classify tickets by type of issue or request.</p>
            <button className="btn btn-primary btn-sm" onClick={() => { setCatEdit(null); setCatName(''); setCatDesc(''); setShowCatForm(true) }}><Icon name="add" size={14} />New category</button>
          </div>

          {categories.length === 0 && <p className="ts-empty">No categories yet.</p>}

          <div className="ts-list">
            {categories.map((cat) => (
              <div key={cat.id} className="ts-list-row">
                <div className="ts-list-info">
                  <span className="ts-list-name">{cat.name}</span>
                  {cat.description && <span className="ts-list-desc">{cat.description}</span>}
                </div>
                <div className="ts-list-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => { setCatEdit(cat); setCatName(cat.name); setCatDesc(cat.description); setShowCatForm(true) }}><Icon name="edit" size={14} />Edit</button>
                  <button className="btn btn-ghost btn-sm btn-danger" onClick={() => void deleteCat(cat.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>

          <Modal open={showCatForm} onClose={() => { if (!busy) { setShowCatForm(false); setCatEdit(null) } }} title={`${catEdit ? 'Edit' : 'New'} Category`}>
            <div className="ts-field" style={{ marginBottom: '1rem' }}>
              <label className="ts-label">Name</label>
              <input className="ts-input" value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="e.g. Hardware, Software" autoFocus />
            </div>
            <div className="ts-field" style={{ marginBottom: '1rem' }}>
              <label className="ts-label">Description</label>
              <input className="ts-input" value={catDesc} onChange={(e) => setCatDesc(e.target.value)} placeholder="Optional" />
            </div>
            <div className="ts-form-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveCat()} disabled={busy || !catName.trim()}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setShowCatForm(false); setCatEdit(null) }}><Icon name="close" size={14} />Cancel</button>
            </div>
          </Modal>
        </div>
      )}

      {/* ═══ ESCALATION ═══ */}
      {tab === 'escalation' && (
        <div className="ts-sections">
          <div className="ts-section-header">
            <p className="ts-section-desc">Automatically escalate tickets based on time and priority.</p>
            <button className="btn btn-primary btn-sm" onClick={() => { setEscName(''); setEscMinutes(60); setEscPriorities([]); setEscTeam(''); setEscAutoAssign(false); setShowEscForm(true) }}><Icon name="add" size={14} />New policy</button>
          </div>

          {escalations.length === 0 && <p className="ts-empty">No escalation policies yet.</p>}

          <div className="ts-list">
            {escalations.map((e) => (
              <div key={e.id} className="ts-list-row">
                <div className="ts-list-info">
                  <span className="ts-list-name">{e.name}</span>
                  <span className="ts-list-desc">
                    After {e.trigger_after_minutes} min
                    {e.trigger_on_priority.length > 0 && ` · ${e.trigger_on_priority.map((p) => p.toUpperCase()).join(', ')}`}
                    {e.target_team_id && ` → ${teams.find((t) => t.id === e.target_team_id)?.name || '?'}`}
                    {e.auto_assign && ' · Auto-assign'}
                  </span>
                </div>
                <div className="ts-list-actions">
                  <span className={`ts-badge ${e.enabled ? 'ts-badge-ok' : 'ts-badge-muted'}`}>{e.enabled ? 'On' : 'Off'}</span>
                  <button className="btn btn-ghost btn-sm btn-danger" onClick={() => void deleteEsc(e.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>

          <Modal open={showEscForm} onClose={() => { if (!busy) setShowEscForm(false) }} title="New Escalation Policy" width={560}>
            <div className="ts-grid-2" style={{ marginBottom: '1rem' }}>
              <div className="ts-field">
                <label className="ts-label">Name</label>
                <input className="ts-input" value={escName} onChange={(e) => setEscName(e.target.value)} placeholder="e.g. Critical response" autoFocus />
              </div>
              <div className="ts-field">
                <label className="ts-label">Trigger after (minutes)</label>
                <input className="ts-input" type="number" min={1} value={escMinutes} onChange={(e) => setEscMinutes(Number(e.target.value))} />
              </div>
            </div>
            <div className="ts-field" style={{ marginBottom: '1rem' }}>
              <label className="ts-label">Trigger on priorities</label>
              <div className="ts-checkbox-row">
                {PRIO.map((p) => (
                  <label key={p} className="ts-checkbox">
                    <input type="checkbox" checked={escPriorities.includes(p)} onChange={() => setEscPriorities((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p])} />
                    <span>{p.toUpperCase()}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="ts-field" style={{ maxWidth: 300, marginBottom: '1rem' }}>
              <label className="ts-label">Target team</label>
              <select className="ts-input" value={escTeam} onChange={(e) => setEscTeam(e.target.value)}>
                <option value="">Keep current team</option>
                {teams.filter((t) => t.accepts_tickets !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <Toggle label="Auto-assign to team members" checked={escAutoAssign} onChange={setEscAutoAssign} />
            <div className="ts-form-actions" style={{ marginTop: '1rem' }}>
              <button className="btn btn-primary btn-sm" onClick={() => void saveEsc()} disabled={busy || !escName.trim()}>{busy ? 'Saving…' : 'Create'}</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowEscForm(false)}>Cancel</button>
            </div>
          </Modal>
        </div>
      )}
    </div>
  )
}
