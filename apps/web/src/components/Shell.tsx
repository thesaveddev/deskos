import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette.js'
import { MobileShell } from './MobileShell.js'
import { useAuth } from '../lib/auth.js'
import { isNative } from '../lib/capacitor.js'
import { lockScreen } from '../lib/lock.js'
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
      label: 'Settings',
      items: [{ to: '/settings', label: 'Settings', show: true }],
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
          <CommandPalette />
          <button
            className="btn btn-ghost btn-sm lock-btn"
            onClick={() => lockScreen()}
            title="Lock screen (Ctrl+L)"
            aria-label="Lock screen"
          >
            🔒
          </button>
          <div className="topbar-user">
            <span>{auth.user?.name}</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                void auth.logout().then(() => navigate('/'))
              }}
            >
              Sign out
            </button>
          </div>
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
