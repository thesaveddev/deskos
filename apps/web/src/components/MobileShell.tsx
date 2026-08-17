import { Link, useLocation } from 'react-router-dom'
import { type ReactNode } from 'react'
import { useAuth } from '../lib/auth.js'
import { useTheme } from '../lib/theme.js'

const TABS = [
  { to: '/', icon: '🏠', label: 'Home' },
  { to: '/tickets', icon: '🎫', label: 'Tickets' },
  { to: '/devices', icon: '💻', label: 'Devices' },
  { to: '/sessions', icon: '🖥️', label: 'Sessions' },
  { to: '/settings', icon: '⚙️', label: 'Settings' },
]

interface Props {
  children: ReactNode
}

export function MobileShell({ children }: Props) {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const user = useAuth((s) => s.user)
  const memberships = useAuth((s) => s.memberships)
  const hasRemote = memberships.some((m) => m.permissions.includes('remote.attended') || m.permissions.includes('remote.unattended'))

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname.startsWith(path)
  }

  return (
    <div className="mobile-shell">
      {/* Top bar */}
      <header className="mobile-topbar">
        <span className="brand" style={{ fontSize: 16 }}>DeskOS</span>
        <div className="mobile-topbar-spacer" />
        <button className="theme-toggle" onClick={toggle} aria-label="Toggle theme">
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
        {user && (
          <div className="mobile-avatar" title={user.name}>
            {user.name?.charAt(0)?.toUpperCase() || '?'}
          </div>
        )}
      </header>

      {/* Content */}
      <main className="mobile-content">
        {children}
      </main>

      {/* Bottom tab bar */}
      <nav className="mobile-tabbar">
        {TABS.map((tab) => {
          // Hide sessions tab if user has no remote permissions
          if (tab.to === '/sessions' && !hasRemote) return null
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`mobile-tab${isActive(tab.to) ? ' active' : ''}`}
            >
              <span className="mobile-tab-icon">{tab.icon}</span>
              <span className="mobile-tab-label">{tab.label}</span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
