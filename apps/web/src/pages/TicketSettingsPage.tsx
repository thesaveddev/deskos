import { useCallback, useEffect, useState } from 'react'
import { Alert } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'

/* ── Types ──────────────────────────────────────────────────── */

interface SlaPolicy {
  id: string
  name: string
  is_default: boolean
  matrix: Record<string, { response: number; resolution: number }>
  business_hours_id: string | null
}

interface Category {
  id: string
  name: string
  description: string
}

interface EscalationPolicy {
  id: number
  name: string
  description: string
  trigger_after_minutes: number
  trigger_on_priority: string[]
  target_team_id: string | null
  auto_assign: boolean
  enabled: boolean
}

interface TenantSettings {
  ticket_prefix: string
  auto_assign_enabled: boolean
  auto_close_enabled: boolean
  auto_close_after_days: number
  lock_timeout_minutes: number
  require_description: boolean
  allow_attachments: boolean
  max_attachment_size_mb: number
  default_priority: string
  default_type: string
  public_notes_visible: boolean
}

interface Team {
  id: string
  name: string
}

const PRIORITY_OPTIONS = ['p1', 'p2', 'p3', 'p4']
const TYPE_OPTIONS = ['incident', 'service_request', 'question', 'problem', 'change']

/* ── Main Component ─────────────────────────────────────────── */

export default function TicketSettingsPage() {
  const auth = useAuth()
  const isOwner = auth.memberships.some((m) => m.tenant.id === auth.activeTenantId && m.orgRole === 'owner')
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('ticket.write') || isOwner

  const [settings, setSettings] = useState<TenantSettings | null>(null)
  const [slaPolicies, setSlaPolicies] = useState<SlaPolicy[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [escalationPolicies, setEscalationPolicies] = useState<EscalationPolicy[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Sla editing
  const [editSla, setEditSla] = useState<SlaPolicy | null>(null)
  const [newSlaName, setNewSlaName] = useState('')
  const [newSlaMatrix, setNewSlaMatrix] = useState<Record<string, { response: number; resolution: number }>>({
    p1: { response: 15, resolution: 240 },
    p2: { response: 60, resolution: 480 },
    p3: { response: 240, resolution: 1440 },
    p4: { response: 480, resolution: 2880 },
  })

  // Category editing
  const [newCatName, setNewCatName] = useState('')
  const [newCatDesc, setNewCatDesc] = useState('')
  const [editCatId, setEditCatId] = useState<string | null>(null)

  // Escalation editing
  const [newEscName, setNewEscName] = useState('')
  const [newEscMinutes, setNewEscMinutes] = useState(60)
  const [newEscPriority, setNewEscPriority] = useState<string[]>([])
  const [newEscTeam, setNewEscTeam] = useState('')
  const [newEscAutoAssign, setNewEscAutoAssign] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const results = await Promise.allSettled([
        api<{ settings: TenantSettings }>('/tenant/settings'),
        api<{ policies: SlaPolicy[] }>('/sla-policies'),
        api<{ categories: Category[] }>('/categories'),
        api<{ policies: EscalationPolicy[] }>('/escalation-policies'),
        api<{ teams: Team[] }>('/teams'),
      ])
      if (results[0].status === 'fulfilled') setSettings(results[0].value.settings)
      if (results[1].status === 'fulfilled') setSlaPolicies(results[1].value.policies || [])
      if (results[2].status === 'fulfilled') setCategories(results[2].value.categories || [])
      if (results[3].status === 'fulfilled') setEscalationPolicies(results[3].value.policies || [])
      if (results[4].status === 'fulfilled') setTeams(results[4].value.teams || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const showNotice = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(null), 3000) }

  // ── Save ticket settings ──
  const saveSettings = async (updates: Partial<TenantSettings>) => {
    if (!settings) return
    setBusy(true)
    try {
      const res = await api<{ settings: TenantSettings }>('/tenant/settings', { method: 'PATCH', body: updates })
      setSettings(res.settings)
      showNotice('Settings saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    }
    setBusy(false)
  }

  // ── SLA CRUD ──
  const saveSla = async () => {
    setBusy(true)
    try {
      if (editSla) {
        await api(`/sla-policies/${editSla.id}`, { method: 'PATCH', body: { name: newSlaName, matrix: newSlaMatrix } })
      } else {
        await api('/sla-policies', { method: 'POST', body: { name: newSlaName, matrix: newSlaMatrix } })
      }
      setEditSla(null); setNewSlaName('')
      await load(); showNotice('SLA policy saved.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteSla = async (id: string) => {
    if (!confirm('Delete this SLA policy?')) return
    try { await api(`/sla-policies/${id}`, { method: 'DELETE' }); await load() } catch { /* silent */ }
  }

  // ── Category CRUD ──
  const saveCategory = async () => {
    if (!newCatName.trim()) return
    setBusy(true)
    try {
      if (editCatId) {
        await api(`/categories/${editCatId}`, { method: 'PATCH', body: { name: newCatName, description: newCatDesc } })
      } else {
        await api('/categories', { method: 'POST', body: { name: newCatName, description: newCatDesc } })
      }
      setEditCatId(null); setNewCatName(''); setNewCatDesc('')
      await load(); showNotice('Category saved.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteCategory = async (id: string) => {
    if (!confirm('Delete this category?')) return
    try { await api(`/categories/${id}`, { method: 'DELETE' }); await load() } catch { /* silent */ }
  }

  // ── Escalation CRUD ──
  const saveEscalation = async () => {
    if (!newEscName.trim()) return
    setBusy(true)
    try {
      await api('/escalation-policies', { method: 'POST', body: {
        name: newEscName,
        trigger_after_minutes: newEscMinutes,
        trigger_on_priority: newEscPriority,
        target_team_id: newEscTeam || null,
        auto_assign: newEscAutoAssign,
      }})
      setNewEscName(''); setNewEscMinutes(60); setNewEscPriority([]); setNewEscTeam(''); setNewEscAutoAssign(false)
      await load(); showNotice('Escalation policy created.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Save failed') }
    setBusy(false)
  }

  const deleteEscalation = async (id: number) => {
    if (!confirm('Delete this escalation policy?')) return
    try { await api(`/escalation-policies/${id}`, { method: 'DELETE' }); await load() } catch { /* silent */ }
  }

  const toggleEscPriority = (p: string) => {
    setNewEscPriority((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p])
  }

  if (loading) return <div className="etch" style={{ padding: 24 }}>Loading ticket settings…</div>

  return (
    <>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      {/* ── General ticket settings ── */}
      <div className="settings-section">
        <h2 className="settings-section-title">General</h2>
        <p className="settings-section-desc">Control how tickets behave across the platform.</p>

        <div className="settings-grid">
          <div className="settings-field">
            <label className="settings-label">Ticket prefix</label>
            <input className="field-input" value={settings?.ticket_prefix || 'TKT'} onChange={(e) => saveSettings({ ticket_prefix: e.target.value })} style={{ maxWidth: 100 }} />
            <span className="settings-hint">Shown before ticket numbers (e.g. TKT-001)</span>
          </div>

          <div className="settings-field">
            <label className="settings-label">Default priority</label>
            <select className="field-input" value={settings?.default_priority || 'p3'} onChange={(e) => saveSettings({ default_priority: e.target.value })}>
              {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p.toUpperCase()}</option>)}
            </select>
          </div>

          <div className="settings-field">
            <label className="settings-label">Default type</label>
            <select className="field-input" value={settings?.default_type || 'incident'} onChange={(e) => saveSettings({ default_type: e.target.value })}>
              {TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
          </div>
        </div>

        <div className="settings-toggle-grid">
          <label className="settings-toggle">
            <input type="checkbox" checked={settings?.require_description ?? true} onChange={(e) => saveSettings({ require_description: e.target.checked })} />
            <span>Require description when creating tickets</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={settings?.allow_attachments ?? true} onChange={(e) => saveSettings({ allow_attachments: e.target.checked })} />
            <span>Allow file attachments on tickets</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={settings?.public_notes_visible ?? true} onChange={(e) => saveSettings({ public_notes_visible: e.target.checked })} />
            <span>Show internal notes in the customer portal</span>
          </label>
        </div>
      </div>

      {/* ── Auto-assignment ── */}
      <div className="settings-section">
        <h2 className="settings-section-title">Auto-assignment</h2>
        <p className="settings-section-desc">Automatically assign new tickets to agents.</p>

        <div className="settings-toggle-grid">
          <label className="settings-toggle">
            <input type="checkbox" checked={settings?.auto_assign_enabled ?? false} onChange={(e) => saveSettings({ auto_assign_enabled: e.target.checked })} />
            <span>Enable automatic ticket assignment</span>
          </label>
          <label className="settings-toggle">
            <input type="checkbox" checked={settings?.auto_close_enabled ?? false} onChange={(e) => saveSettings({ auto_close_enabled: e.target.checked })} />
            <span>Auto-close resolved tickets after inactivity</span>
          </label>
        </div>

        {settings?.auto_close_enabled && (
          <div className="settings-field" style={{ marginTop: '0.75rem' }}>
            <label className="settings-label">Auto-close after (days)</label>
            <input className="field-input" type="number" min={1} max={90} value={settings?.auto_close_after_days || 7} onChange={(e) => saveSettings({ auto_close_after_days: Number(e.target.value) })} style={{ maxWidth: 100 }} />
          </div>
        )}
      </div>

      {/* ── SLA Policies ── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2 className="settings-section-title">SLA Policies</h2>
            <p className="settings-section-desc">Define response and resolution time targets per priority.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setEditSla(null); setNewSlaName('') }}>+ New policy</button>
        </div>

        {slaPolicies.map((sla) => (
          <div key={sla.id} className="settings-card">
            <div className="settings-card-header">
              <span className="settings-card-name">{sla.name} {sla.is_default && <span className="settings-badge">Default</span>}</span>
              <div className="settings-card-actions">
                <button className="btn btn-ghost btn-xs" onClick={() => { setEditSla(sla); setNewSlaName(sla.name); setNewSlaMatrix(sla.matrix || newSlaMatrix) }}>Edit</button>
                {!sla.is_default && <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void deleteSla(sla.id)}>Delete</button>}
              </div>
            </div>
            <div className="settings-sla-matrix">
              <div className="settings-sla-header">
                <span>Priority</span><span>Response</span><span>Resolution</span>
              </div>
              {Object.entries(sla.matrix || {}).map(([p, times]) => (
                <div key={p} className="settings-sla-row">
                  <span className="settings-sla-prio">{p.toUpperCase()}</span>
                  <span>{times.response < 60 ? `${times.response}m` : `${Math.round(times.response / 60)}h`}</span>
                  <span>{times.resolution < 60 ? `${times.resolution}m` : times.resolution < 1440 ? `${Math.round(times.resolution / 60)}h` : `${Math.round(times.resolution / 1440)}d`}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* SLA form */}
        {(editSla || newSlaName || slaPolicies.length === 0) && (
          <div className="settings-form-card">
            <h4 className="settings-form-title">{editSla ? 'Edit SLA Policy' : 'New SLA Policy'}</h4>
            <div className="settings-field">
              <label className="settings-label">Policy name</label>
              <input className="field-input" value={newSlaName} onChange={(e) => setNewSlaName(e.target.value)} placeholder="e.g. Standard SLA" />
            </div>
            <div className="settings-sla-editor">
              {PRIORITY_OPTIONS.map((p) => (
                <div key={p} className="settings-sla-edit-row">
                  <span className="settings-sla-prio">{p.toUpperCase()}</span>
                  <div className="settings-sla-edit-fields">
                    <label className="settings-sla-edit-label">Response (min)</label>
                    <input className="field-input field-input-sm" type="number" min={0} value={newSlaMatrix[p]?.response ?? 0} onChange={(e) => setNewSlaMatrix((m) => ({ ...m, [p]: { ...m[p], response: Number(e.target.value) } }))} />
                    <label className="settings-sla-edit-label">Resolution (min)</label>
                    <input className="field-input field-input-sm" type="number" min={0} value={newSlaMatrix[p]?.resolution ?? 0} onChange={(e) => setNewSlaMatrix((m) => ({ ...m, [p]: { ...m[p], resolution: Number(e.target.value) } }))} />
                  </div>
                </div>
              ))}
            </div>
            <div className="settings-form-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveSla()} disabled={busy || !newSlaName.trim()}>{busy ? 'Saving…' : 'Save policy'}</button>
              {editSla && <button className="btn btn-ghost btn-sm" onClick={() => { setEditSla(null); setNewSlaName('') }}>Cancel</button>}
            </div>
          </div>
        )}
      </div>

      {/* ── Categories ── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2 className="settings-section-title">Categories</h2>
            <p className="settings-section-desc">Classify tickets by type of issue or request.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setEditCatId(null); setNewCatName(''); setNewCatDesc('') }}>+ New category</button>
        </div>

        {categories.length > 0 && (
          <div className="settings-list">
            {categories.map((cat) => (
              <div key={cat.id} className="settings-list-row">
                <div className="settings-list-info">
                  <span className="settings-list-name">{cat.name}</span>
                  {cat.description && <span className="settings-list-desc">{cat.description}</span>}
                </div>
                <div className="settings-list-actions">
                  <button className="btn btn-ghost btn-xs" onClick={() => { setEditCatId(cat.id); setNewCatName(cat.name); setNewCatDesc(cat.description) }}>Edit</button>
                  <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void deleteCategory(cat.id)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Category form */}
        {(editCatId || newCatName || categories.length === 0) && (
          <div className="settings-form-card">
            <h4 className="settings-form-title">{editCatId ? 'Edit Category' : 'New Category'}</h4>
            <div className="settings-field">
              <label className="settings-label">Name</label>
              <input className="field-input" value={newCatName} onChange={(e) => setNewCatName(e.target.value)} placeholder="e.g. Hardware, Software, Network" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Description</label>
              <input className="field-input" value={newCatDesc} onChange={(e) => setNewCatDesc(e.target.value)} placeholder="Optional description" />
            </div>
            <div className="settings-form-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveCategory()} disabled={busy || !newCatName.trim()}>{busy ? 'Saving…' : 'Save'}</button>
              {editCatId && <button className="btn btn-ghost btn-sm" onClick={() => { setEditCatId(null); setNewCatName(''); setNewCatDesc('') }}>Cancel</button>}
            </div>
          </div>
        )}
      </div>

      {/* ── Escalation Policies ── */}
      <div className="settings-section">
        <div className="settings-section-header">
          <div>
            <h2 className="settings-section-title">Escalation Policies</h2>
            <p className="settings-section-desc">Automatically escalate tickets based on time and priority.</p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setNewEscName(''); setNewEscMinutes(60); setNewEscPriority([]); setNewEscTeam(''); setNewEscAutoAssign(false) }}>+ New policy</button>
        </div>

        {escalationPolicies.map((esc) => (
          <div key={esc.id} className="settings-card">
            <div className="settings-card-header">
              <span className="settings-card-name">{esc.name}</span>
              <div className="settings-card-actions">
                <span className={`settings-badge ${esc.enabled ? 'settings-badge-ok' : 'settings-badge-muted'}`}>{esc.enabled ? 'Enabled' : 'Disabled'}</span>
                <button className="btn btn-ghost btn-xs btn-danger" onClick={() => void deleteEscalation(esc.id)}>Delete</button>
              </div>
            </div>
            <div className="settings-card-meta">
              <span>After {esc.trigger_after_minutes} minutes</span>
              {esc.trigger_on_priority.length > 0 && <span>· Priorities: {esc.trigger_on_priority.join(', ')}</span>}
              {esc.target_team_id && <span>· → {teams.find((t) => t.id === esc.target_team_id)?.name || 'Unknown team'}</span>}
              {esc.auto_assign && <span>· Auto-assign</span>}
            </div>
          </div>
        ))}

        {/* Escalation form */}
        {newEscName !== undefined && (
          <div className="settings-form-card">
            <h4 className="settings-form-title">New Escalation Policy</h4>
            <div className="settings-field">
              <label className="settings-label">Name</label>
              <input className="field-input" value={newEscName} onChange={(e) => setNewEscName(e.target.value)} placeholder="e.g. Critical response" />
            </div>
            <div className="settings-field">
              <label className="settings-label">Trigger after (minutes)</label>
              <input className="field-input" type="number" min={1} value={newEscMinutes} onChange={(e) => setNewEscMinutes(Number(e.target.value))} style={{ maxWidth: 120 }} />
            </div>
            <div className="settings-field">
              <label className="settings-label">Trigger on priorities</label>
              <div className="settings-checkbox-row">
                {PRIORITY_OPTIONS.map((p) => (
                  <label key={p} className="settings-checkbox">
                    <input type="checkbox" checked={newEscPriority.includes(p)} onChange={() => toggleEscPriority(p)} />
                    <span>{p.toUpperCase()}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="settings-field">
              <label className="settings-label">Target team</label>
              <select className="field-input" value={newEscTeam} onChange={(e) => setNewEscTeam(e.target.value)}>
                <option value="">Keep current team</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <label className="settings-toggle" style={{ marginTop: '0.5rem' }}>
              <input type="checkbox" checked={newEscAutoAssign} onChange={(e) => setNewEscAutoAssign(e.target.checked)} />
              <span>Auto-assign to team members</span>
            </label>
            <div className="settings-form-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void saveEscalation()} disabled={busy || !newEscName.trim()}>{busy ? 'Saving…' : 'Create policy'}</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
