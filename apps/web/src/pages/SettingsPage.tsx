import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field } from '../components/ui.js'
import { getTenant, updateTenant } from '../lib/tenant.js'
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes } from '../lib/idle.js'
import TicketSettingsPage from './TicketSettingsPage.js'
function BasicSettings() {
  const [form, setForm] = useState<{ name: string; slug: string; region: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    getTenant()
      .then((r) => setForm({ name: r.tenant.name, slug: r.tenant.slug, region: r.tenant.region }))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load settings'))
  }, [])

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    if (!form) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await updateTenant(form)
      setForm({ name: r.tenant.name, slug: r.tenant.slug, region: r.tenant.region })
      setNotice('Settings saved.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  if (!form) return <div className="etch" style={{ padding: 24 }}>Loading settings…</div>

  return (
    <div className="form-panel">
      <h2 className="channel-form-title">Organization</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        These details identify your organization. The slug is used in portal links and must be unique.
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      <form onSubmit={handleSave}>
        <Field label="Organization name">
          <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
        </Field>
        <Field label="Slug" hint="lowercase letters, numbers, and hyphens">
          <input className="field-input" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} required />
        </Field>
        <Field label="Region">
          <input className="field-input" value={form.region} onChange={(e) => setForm({ ...form, region: e.target.value })} required />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </div>
  )
}

function PreferencesSettings() {
  const [idleMinutes, setIdleMinutes] = useState(getIdleTimeoutMinutes())
  const [notice, setNotice] = useState<string | null>(null)

  const handleSave = () => {
    setIdleTimeoutMinutes(idleMinutes)
    setNotice('Preferences saved.')
    setTimeout(() => setNotice(null), 2000)
  }

  return (
    <div className="form-panel">
      <h2 className="channel-form-title">Preferences</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Personal settings that apply to your account across all organizations.
      </p>
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <Field label="Screen lock timeout" hint="Minutes of inactivity before your screen locks (1–120, or 0 to disable)">
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <input
            className="field-input"
            type="number"
            min={0}
            max={120}
            value={idleMinutes}
            onChange={(e) => setIdleMinutes(Math.max(0, Math.min(120, Number(e.target.value))))}
            style={{ maxWidth: 100 }}
          />
          <span className="muted" style={{ fontSize: '0.8rem' }}>
            {idleMinutes === 0 ? 'Disabled' : `${idleMinutes} minute${idleMinutes !== 1 ? 's' : ''}`}
          </span>
        </div>
      </Field>

      <div className="form-actions">
        <button className="btn btn-primary" onClick={handleSave}>Save preferences</button>
      </div>
    </div>
  )
}

export default function SettingsPage() {
  const location = useLocation()
  const tab = location.pathname.startsWith('/settings/email')
    ? 'email'
    : location.pathname.startsWith('/settings/integrations')
      ? 'integrations'
      : location.pathname.startsWith('/settings/canned')
        ? 'canned'
        : location.pathname.startsWith('/settings/notifications')
          ? 'notifications'
        : location.pathname.startsWith('/settings/security')
          ? 'security'
        : location.pathname.startsWith('/settings/active-directory')
          ? 'active-directory'
          : location.pathname.startsWith('/settings/api')
            ? 'api'
            : location.pathname.startsWith('/settings/preferences')
              ? 'preferences'
              : location.pathname.startsWith('/settings/tickets')
                ? 'tickets'
                : 'basic'

  return (
    <Shell>
      <div className="page-head">
        <button className="btn btn-ghost btn-sm" onClick={() => window.history.back()} style={{ marginRight: 8 }}>
          ← Back
        </button>
        <h1 className="page-title">Settings</h1>
      </div>
      <div className="settings-tabs">
        <NavLink to="/settings" end className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Basic
        </NavLink>
        <NavLink to="/settings/preferences" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Preferences
        </NavLink>
        <NavLink to="/settings/tickets" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Tickets
        </NavLink>
        <NavLink to="/settings/email" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Email
        </NavLink>
        <NavLink to="/settings/integrations" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Integrations
        </NavLink>
        <NavLink to="/settings/canned" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Canned responses
        </NavLink>
        <NavLink to="/settings/notifications" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Notifications
        </NavLink>
        <NavLink to="/settings/security" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Security
        </NavLink>
        <NavLink to="/settings/active-directory" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Active Directory
        </NavLink>
        <NavLink to="/settings/api" className={({ isActive }) => `settings-tab${isActive ? ' active' : ''}`}>
          Public API
        </NavLink>
      </div>
      <div className="settings-body">{tab === 'basic' ? <BasicSettings /> : tab === 'preferences' ? <PreferencesSettings /> : tab === 'tickets' ? <TicketSettingsPage /> : <Outlet />}</div>
    </Shell>
  )
}
