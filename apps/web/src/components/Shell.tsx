import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette.js'
import { useAuth } from '../lib/auth.js'
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
        { to: '/', end: true, label: 'Home', show: true },
        { to: '/tickets', label: 'Tickets', show: true },
        { to: '/tickets/new', label: 'New ticket', show: true },
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

  return (
    <div className="app-frame">
      {navOpen ? <div className="nav-backdrop" onClick={() => setNavOpen(false)} aria-hidden="true" /> : null}
      <aside className={`nav-rail${navOpen ? ' open' : ''}`}>
        <div className="nav-brand">
          <span className="brand">DeskOS</span>
        </div>
        <nav className="nav-items" onClick={() => setNavOpen(false)}>
          <NavSections />
        </nav>
        <div className="nav-footer">
          <span className="etch">Phase 1 · M3</span>
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
        <main className="app-content">{children}</main>
      </div>
    </div>
  )
}
