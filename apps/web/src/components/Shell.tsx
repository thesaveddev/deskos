import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette.js'
import { MobileShell } from './MobileShell.js'
import { NotesDropdown } from './NotesDropdown.js'
import { useAuth } from '../lib/auth.js'
import { isNative } from '../lib/capacitor.js'
import { lockScreen } from '../lib/lock.js'
import { createAdhocSession } from '../lib/sessions.js'
import { readSessionDock, sessionDockEventName, type SessionDockEntry } from '../lib/sessions.js'

function tenantColor(id?: string): string {
  if (!id) return 'var(--accent)'
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h} 55% 45%)`
}

interface NavItem {
  to: string
  label: string
  end?: boolean
  show: boolean
}

interface NavSection {
  label: string
  items: NavItem[]
}

function NavIcon({ name }: { name: string }) {
  const s = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const icons: Record<string, React.ReactNode> = {
    dashboard: <svg {...s}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
    tickets: <svg {...s}><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>,
    approvals: <svg {...s}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>,
    devices: <svg {...s}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
    sessions: <svg {...s}><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>,
    endpoints: <svg {...s}><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="13" y2="13"/></svg>,
    monitoring: <svg {...s}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>,
    kb: <svg {...s}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>,
    automations: <svg {...s}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
    scripts: <svg {...s}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    assets: <svg {...s}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>,
    services: <svg {...s}><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>,
    incidents: <svg {...s}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    patches: <svg {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    reports: <svg {...s}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
    compliance: <svg {...s}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
    chat: <svg {...s}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    calls: <svg {...s}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
    msp: <svg {...s}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    access: <svg {...s}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>,
    ai: <svg {...s}><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 2v10l7-3"/></svg>,
    integrations: <svg {...s}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
    developer: <svg {...s}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>,
    marketplace: <svg {...s}><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>,
    staff: <svg {...s}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    support: <svg {...s}><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
    profile: <svg {...s}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>,
    billing: <svg {...s}><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
    settings: <svg {...s}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>,
  }
  return <span className="nav-item-icon">{icons[name] ?? null}</span>
}

const NAV_ICON_MAP: Record<string, string> = {
  '/': 'dashboard', '/tickets': 'tickets', '/approvals': 'approvals',
  '/devices': 'devices', '/sessions': 'sessions', '/rmm': 'endpoints', '/monitoring': 'monitoring',
  '/kb': 'kb', '/automations': 'automations', '/scripts': 'scripts',
  '/assets': 'assets', '/services': 'services', '/incidents': 'incidents', '/patches': 'patches',
  '/reports': 'reports', '/compliance': 'compliance',
  '/chat': 'chat', '/calls': 'calls',
  '/msp': 'msp', '/grants': 'access', '/ai-agent': 'ai', '/integrations': 'integrations',
  '/developer': 'developer', '/marketplace': 'marketplace',
  '/staff': 'staff', '/support': 'support',
  '/profile': 'profile', '/billing': 'billing', '/settings': 'settings',
}

/** Categorised sidebar navigation, driven by the caller's permissions. */
function NavSections() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const can = (p: string) => perms.has(p)
  const anyRemote = ['remote.attended', 'remote.unattended', 'remote.control', 'remote.inspection'].some(can)

  const sections: NavSection[] = [
    {
      label: 'Service desk',
      items: [
        { to: '/', end: true, label: 'Dashboard', show: true },
        { to: '/tickets', label: 'Tickets', show: true },
        { to: '/approvals', label: 'Approvals', show: true },

      ],
    },
    {
      label: 'Remote support',
      items: [
        { to: '/devices', label: 'Devices', show: can('device.read') },
        { to: '/sessions', label: 'Sessions', show: anyRemote },
        { to: '/rmm', label: 'Endpoints', show: can('rmm.read') },
        { to: '/monitoring', label: 'Monitoring', show: can('monitoring.read') },
      ],
    },
    {
      label: 'Knowledge & automation',
      items: [
        { to: '/kb', label: 'Knowledge base', show: can('kb.read') },
        { to: '/automations', label: 'Automations', show: can('automation.read') },
        { to: '/scripts', label: 'Scripts', show: can('script.read') },
      ],
    },
    {
      label: 'ITSM',
      items: [
        { to: '/assets', label: 'Assets', show: can('asset.read') },
        { to: '/services', label: 'Services', show: can('catalogue.read') },
        { to: '/incidents', label: 'Incidents', show: can('incident.read') },
        { to: '/patches', label: 'Patches', show: can('patch.read') },
        { to: '/reports', label: 'Reports', show: can('report.read') },
        { to: '/compliance', label: 'Compliance', show: can('audit.read') },
      ],
    },
    {
      label: 'Communication',
      items: [
        { to: '/chat', label: 'Team chat', show: can('chat.read') },
        { to: '/calls', label: 'Calls', show: can('telephony.read') },
      ],
    },
    {
      label: 'Platform & integrations',
      items: [
        { to: '/msp', label: 'MSP', show: can('tenant.manage') || auth.memberships.length > 1 },
        { to: '/grants', label: 'Access', show: can('grant.read') },
        { to: '/ai-agent', label: 'AI agent', show: can('ai_agent.read') },
        { to: '/integrations', label: 'Integrations', show: can('integration.read') },
        { to: '/developer', label: 'Developer API', show: can('integration.read') },
        { to: '/marketplace', label: 'Marketplace', show: can('marketplace.read') },
      ],
    },
    {
      label: 'Team',
      items: [
        { to: '/staff', label: 'Staff management', show: can('member.read') },
        { to: '/support', label: 'Support', show: true },
      ],
    },
    {
      label: 'Account',
      items: [
        { to: '/profile', label: 'My profile', show: true },
        { to: '/billing', label: 'Billing', show: true },
        { to: '/settings', label: 'Settings', show: true },
      ],
    },
  ]

  return (
    <>
      {sections.map((section) => {
        const visible = section.items.filter((item) => item.show)
        if (visible.length === 0) return null
        return (
          <div key={section.label} className="nav-section">
            <span className="nav-section-label">{section.label}</span>
            {visible.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
              >
                <NavIcon name={NAV_ICON_MAP[item.to] ?? 'dashboard'} />
                {item.label}
              </NavLink>
            ))}
          </div>
        )
      })}
    </>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  // Auto-switch to mobile shell on native platforms
  if (isNative()) return <MobileShell>{children}</MobileShell>
  const auth = useAuth()
  const navigate = useNavigate()
  const [navOpen, setNavOpen] = useState(false)
  const [sessionDock, setSessionDock] = useState<SessionDockEntry | null>(() => readSessionDock())
  const [notesOpen, setNotesOpen] = useState(false)
  const [showSessionKey, setShowSessionKey] = useState(false)
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [sessionKeyExpires, setSessionKeyExpires] = useState<string | null>(null)
  const [sessionKeyBusy, setSessionKeyBusy] = useState(false)

  useEffect(() => {
    const refresh = () => setSessionDock(readSessionDock())
    window.addEventListener(sessionDockEventName, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(sessionDockEventName, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  // Global Ctrl+L shortcut to lock screen
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault()
        lockScreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-frame">
      <a href="#main-content" className="skip-link" style={{
        position: 'absolute', left: '-10000px', top: 'auto', width: '1px', height: '1px', overflow: 'hidden',
        zIndex: '9999', padding: '8px 16px', background: 'var(--accent)', color: '#1b1408',
        fontWeight: 600, fontSize: 14, borderRadius: 'var(--radius-sm)', textDecoration: 'none',
      }} onFocus={(e) => { e.currentTarget.style.left = '8px'; e.currentTarget.style.top = '8px'; e.currentTarget.style.width = 'auto'; e.currentTarget.style.height = 'auto' }} onBlur={(e) => { e.currentTarget.style.left = '-10000px'; e.currentTarget.style.width = '1px'; e.currentTarget.style.height = '1px' }}>
        Skip to content
      </a>
      {navOpen ? <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}
      <aside className={`nav-rail${navOpen ? ' open' : ''}`} role="navigation" aria-label="Main navigation">
        <div className="nav-brand">
          <span className="brand">DeskOS</span>
        </div>
        <nav className="nav-items" onClick={() => setNavOpen(false)}>
          <NavSections />
        </nav>
        <div className="nav-footer">
          <span className="etch">DeskOS IT Support OS</span>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-label="Open navigation" aria-expanded={navOpen}>
            ☰
          </button>
          <span className="topbar-org">
            {(auth.memberships.find((m) => m.tenant.id === auth.activeTenantId) ?? auth.memberships[0])?.tenant.name ?? 'DeskOS'}
          </span>
          <span className="topbar-slug">/{(auth.memberships.find((m) => m.tenant.id === auth.activeTenantId) ?? auth.memberships[0])?.tenant.slug ?? ''}</span>
          {auth.memberships.length > 1 ? (
            <select
              className="field-input select-sm tenant-switcher"
              value={auth.activeTenantId ?? auth.memberships[0]?.tenant.id ?? ''}
              onChange={(e) => {
                auth.switchTenant(e.target.value)
                window.location.reload()
              }}
              aria-label="Active organization"
            >
              {auth.memberships.map((m) => (
                <option key={m.tenant.id} value={m.tenant.id}>{m.tenant.name}</option>
              ))}
            </select>
          ) : null}
          <div className="topbar-spacer" />

          {/* Remote Session button + key dropdown */}
          <div className="topbar-remote-wrap">
            <button
              className="btn btn-remote-session"
              onClick={() => {
                if (showSessionKey) { setShowSessionKey(false); return }
                setSessionKeyBusy(true)
                setShowSessionKey(true)
                setSessionKey(null)
                createAdhocSession({
                  permissions: ['view_screen', 'control_input', 'clipboard', 'terminal', 'elevation', 'file_transfer', 'system_manage'],
                  expiresInMin: 10,
                }).then((res) => {
                  setSessionKey(res.code)
                  setSessionKeyExpires(res.expiresAt)
                }).catch(() => {
                  setSessionKey(null)
                }).finally(() => setSessionKeyBusy(false))
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              Remote Session
            </button>
            {showSessionKey && (
              <div className="session-key-dropdown">
                <button className="session-key-close" onClick={() => setShowSessionKey(false)}>✕</button>
                <h4 className="session-key-title">Session Key</h4>
                {sessionKeyBusy ? (
                  <div className="session-key-loading">Generating…</div>
                ) : sessionKey ? (
                  <>
                    <div className="session-key-code">{sessionKey}</div>
                    <span className="session-key-validity">Valid for 10 minutes</span>
                    <button
                      className="session-key-email"
                      onClick={() => {
                        const url = `${window.location.origin}/connect/${sessionKey}`
                        window.open(`mailto:?subject=DeskOS Support Session&body=Join my support session:%0A%0A${url}%0A%0ACode: ${sessionKey}`, '_blank')
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      Send Email
                    </button>
                  </>
                ) : (
                  <div className="session-key-error">Failed to generate key</div>
                )}
              </div>
            )}
          </div>

          <Link to="/tickets/new" className="btn btn-new-ticket">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Ticket
          </Link>

          <div className="topbar-icons">
            <button className="topbar-icon-btn" title="Notifications">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </button>
          </div>

          {/* Notes dropdown */}
          <div className="topbar-notes-wrap">
            <button
              className="topbar-icon-btn"
              title="Notes"
              onClick={() => setNotesOpen(!notesOpen)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </button>
            <NotesDropdown open={notesOpen} onClose={() => setNotesOpen(false)} />
          </div>

          <CommandPalette />
          <button
            className="btn btn-ghost btn-sm lock-btn"
            onClick={() => lockScreen()}
            title="Lock screen (Ctrl+L)"
            aria-label="Lock screen"
          >
            🔒
          </button>
          <button
            className="btn btn-ghost btn-sm topbar-icon-btn"
            onClick={() => { void auth.logout().then(() => navigate('/')) }}
            title="Sign out"
            aria-label="Sign out"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </header>
        {auth.memberships.length > 1 ? (
          <div className="msp-banner" role="status">
            <span
              className="msp-banner-dot"
              aria-hidden="true"
              style={{ background: tenantColor(auth.activeTenantId ?? auth.memberships[0]?.tenant.id) }}
            />
            <span>
              Managing <strong>{(auth.memberships.find((m) => m.tenant.id === auth.activeTenantId) ?? auth.memberships[0])?.tenant.name}</strong> · {auth.memberships.length} organizations available
            </span>
          </div>
        ) : null}
        {sessionDock ? (
          <div className="session-dock" role="status">
            <span className="session-dock-dot" aria-hidden="true" />
            <span className="session-dock-copy">
              <span className="session-dock-label">Remote session</span>
              <strong>{sessionDock.deviceName}</strong>
            </span>
            <span className="mono muted session-dock-state">{sessionDock.state}</span>
            <Link className="btn btn-ghost btn-sm" to={`/sessions/${sessionDock.id}`}>Return</Link>
          </div>
        ) : null}
        <main className="app-content" id="main-content" tabIndex={-1}>{children}</main>
      </div>
    </div>
  )
}
