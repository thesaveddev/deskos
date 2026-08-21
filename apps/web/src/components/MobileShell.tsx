import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useState, type ReactNode } from 'react'
import { useAuth } from '../lib/auth.js'
import { useTheme } from '../lib/theme.js'
import { lockScreen, rememberLockedUser } from '../lib/lock.js'
import { Icon, type IconName } from './Icons.js'
import { BRAND } from '../lib/brand.js'

interface MobileTab {
  to: string
  icon: IconName
  label: string
  show: boolean
}

interface Props {
  children: ReactNode
}

function pageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard'
  if (pathname.startsWith('/tickets')) return 'Tickets'
  if (pathname.startsWith('/devices')) return 'Devices'
  if (pathname.startsWith('/sessions')) return 'Sessions'
  if (pathname.startsWith('/settings')) return 'Settings'
  if (pathname.startsWith('/reports')) return 'Reports'
  if (pathname.startsWith('/kb')) return 'Knowledge base'
  if (pathname.startsWith('/learn')) return 'Learn'
  if (pathname.startsWith('/monitoring')) return 'Monitoring'
  if (pathname.startsWith('/profile')) return 'Profile'
  return BRAND.name
}

export function MobileShell({ children }: Props) {
  const location = useLocation()
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()
  const auth = useAuth()
  const [moreOpen, setMoreOpen] = useState(false)

  const permissions = new Set(auth.memberships.flatMap((membership) => membership.permissions))
  const can = (permission: string) => permissions.has(permission)
  const hasRemote = ['remote.attended', 'remote.unattended', 'remote.control', 'remote.inspection'].some(can)
  const hasDevices = can('device.read')
  const isNested = location.pathname !== '/' && !['/tickets', '/devices', '/sessions', '/settings'].includes(location.pathname)

  const tabs: MobileTab[] = [
    { to: '/', icon: 'monitor', label: 'Dashboard', show: true },
    { to: '/tickets', icon: 'ticket', label: 'Tickets', show: true },
    { to: '/devices', icon: 'monitor', label: 'Devices', show: hasDevices },
    { to: '/sessions', icon: 'play', label: 'Sessions', show: hasRemote },
    { to: '/settings', icon: 'settings', label: 'Settings', show: true },
  ]

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname === path || location.pathname.startsWith(`${path}/`)
  }

  const moreLinks: Array<{ to: string; icon: IconName; label: string; show: boolean }> = [
    { to: '/reports', icon: 'calendar', label: 'Reports', show: can('report.read') },
    { to: '/monitoring', icon: 'alert', label: 'Monitoring', show: can('monitoring.read') },
    { to: '/kb', icon: 'folder', label: 'Knowledge base', show: can('kb.read') },
    { to: '/learn', icon: 'folder', label: 'Learn', show: true },
    { to: '/staff', icon: 'user', label: 'Staff management', show: can('member.read') },
    { to: '/profile', icon: 'user', label: 'My profile', show: true },
    { to: '/billing', icon: 'calendar', label: 'Billing', show: true },
  ]

  return (
    <div className="mobile-shell">
      <header className="mobile-topbar">
        {isNested ? (
          <button
            type="button"
            className="mobile-topbar-action"
            onClick={() => navigate(-1)}
            aria-label="Go back"
          >
            <Icon name="back" size={19} />
          </button>
        ) : null}
        <div className="mobile-title-block">
          <span className="brand" style={{ fontSize: 16 }}>{BRAND.name}</span>
          <span className="mobile-page-title">{pageTitle(location.pathname)}</span>
        </div>
        <div className="mobile-topbar-spacer" />
        <button
          type="button"
          className="mobile-topbar-action"
          onClick={() => navigate('/tickets/new')}
          aria-label="Create ticket"
          title="Create ticket"
        >
          <Icon name="add" size={19} />
        </button>
        <button
          type="button"
          className="theme-toggle mobile-theme-toggle"
          onClick={toggle}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        {auth.user ? (
          <button
            type="button"
            className="mobile-avatar"
            onClick={() => setMoreOpen(true)}
            title="Open account menu"
            aria-label="Open account menu"
          >
            {auth.user.name?.charAt(0)?.toUpperCase() || '?'}
          </button>
        ) : null}
      </header>

      <main className="mobile-content">{children}</main>

      {moreOpen ? (
        <div className="mobile-more-layer" role="presentation" onMouseDown={() => setMoreOpen(false)}>
          <section
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`More ${BRAND.name} navigation`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mobile-more-head">
              <div>
                <strong>{auth.user?.name ?? 'Account'}</strong>
                <span>{auth.user?.email ?? ''}</span>
              </div>
              <button type="button" className="mobile-topbar-action" onClick={() => setMoreOpen(false)} aria-label="Close menu">
                <Icon name="close" size={18} />
              </button>
            </div>
            <div className="mobile-more-links">
              {moreLinks.filter((link) => link.show).map((link) => (
                <Link key={link.to} to={link.to} className="mobile-more-link" onClick={() => setMoreOpen(false)}>
                  <Icon name={link.icon} size={18} />
                  <span>{link.label}</span>
                  <Icon name="chevron-right" size={16} />
                </Link>
              ))}
            </div>
            <div className="mobile-more-actions">
              <button type="button" className="btn btn-ghost btn-block" onClick={() => { setMoreOpen(false); lockScreen() }}>
                <Icon name="lock" size={16} /> Lock screen
              </button>
              <button type="button" className="btn btn-ghost btn-block" onClick={() => {
                setMoreOpen(false)
                if (!auth.user) return
                rememberLockedUser(auth.user)
                void auth.logout().then(() => navigate('/lock'))
              }}>
                <Icon name="logout" size={16} /> Sign out
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <nav className="mobile-tabbar" aria-label="Primary navigation">
        {tabs.filter((tab) => tab.show).map((tab) => (
          <Link
            key={tab.to}
            to={tab.to}
            className={`mobile-tab${isActive(tab.to) ? ' active' : ''}`}
          >
            <span className="mobile-tab-icon"><Icon name={tab.icon} size={18} /></span>
            <span className="mobile-tab-label">{tab.label}</span>
          </Link>
        ))}
        <button type="button" className="mobile-tab" onClick={() => setMoreOpen(true)} aria-label="More navigation">
          <span className="mobile-tab-icon"><Icon name="more" size={18} /></span>
          <span className="mobile-tab-label">More</span>
        </button>
      </nav>
    </div>
  )
}
