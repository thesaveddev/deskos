import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette.js'
import { MobileShell } from './MobileShell.js'
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
        { to: '/notes', label: 'Notes', show: true },
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
            <Link to="/approvals" className="topbar-icon-btn" title="Approvals">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            </Link>
            <Link to="/kb" className="topbar-icon-btn" title="Knowledge base">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
            </Link>
            <button className="topbar-icon-btn" title="Notifications">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            </button>
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
