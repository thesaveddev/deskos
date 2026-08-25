import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth.js'
import { rememberLockedUser } from '../lib/lock.js'
import { BRAND } from '../lib/brand.js'
import { Icon } from './Icons.js'

/**
 * Customer portal shell. A deliberately lighter frame than the technician
 * console: brand, tenant, and a "Technician console" link for staff who also
 * browse the portal. End users see the portal and nothing else.
 */
export function PortalShell({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const isStaff = auth.memberships.some((m) =>
    m.permissions.includes('ticket.read') || m.permissions.includes('ticket.write'),
  )
  const active = auth.memberships.find((m) => m.tenant.id === auth.activeTenantId) ?? auth.memberships[0]
  const branding = active?.tenant.branding

  const isActive = (path: string) => location.pathname === path ? ' active' : ''

  return (
    <div className="app-frame" style={branding?.primaryColor ? ({ ['--accent' as string]: branding.primaryColor }) : undefined}>
      <aside className="nav-rail portal-rail">
        <div className="nav-brand">
          {branding?.logoUrl ? <img className="brand-logo" src={branding.logoUrl} alt="" aria-hidden="true" /> : null}
          <span className="brand">{branding?.portalTitle || BRAND.name}</span>
          <span className="etch">Support portal</span>
        </div>
        <nav className="nav-items">
          <Link to="/portal" className={`nav-item${isActive('/portal')}`}>
            <Icon name="ticket" size={16} />
            <span>My requests</span>
          </Link>
          <Link to="/portal/new" className={`nav-item${isActive('/portal/new')}`}>
            <Icon name="add" size={16} />
            <span>New request</span>
          </Link>
        </nav>
        <div className="nav-footer">
          {isStaff ? (
            <Link to="/" className="btn btn-ghost btn-sm" style={{ width: '100%', justifyContent: 'center' }}>
              <Icon name="external" size={14} />
              Technician console
            </Link>
          ) : null}
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <span className="topbar-org">{active?.tenant.name ?? 'Support portal'}</span>
          <span className="topbar-slug">/{active?.tenant.slug ?? ''}</span>
          <div className="topbar-spacer" />
          <div className="topbar-user">
            <span>{auth.user?.name}</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (!auth.user) return
                rememberLockedUser(auth.user)
                void auth.logout().then(() => navigate('/login'))
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="app-content">{children}</main>
      </div>
    </div>
  )
}
