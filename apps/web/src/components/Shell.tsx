import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { CommandPalette } from './CommandPalette.js'
import { MobileShell } from './MobileShell.js'
import { NotesDropdown } from './NotesDropdown.js'
import { QuickTicketModal } from './QuickTicketModal.js'
import { useAuth } from '../lib/auth.js'
import { isNative } from '../lib/capacitor.js'
import { lockScreen, rememberLockedUser } from '../lib/lock.js'
import { createAdhocSession, emailAdhocSession } from '../lib/sessions.js'
import { Icon } from './Icons.js'
import { readSessionDock, sessionDockEventName, type SessionDockEntry } from '../lib/sessions.js'
import { listNotifications, markNotificationsRead, openNotificationStream, type AppNotification } from '../lib/notifications.js'
import { BRAND } from '../lib/brand.js'

function tenantColor(id?: string): string {
  if (!id) return 'var(--accent)'
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360
  return `hsl(${h} 55% 45%)`
}

function notificationLabel(kind: string): string {
  const labels: Record<string, string> = {
    'ticket.replied': 'Ticket update',
    'ticket.requester_replied': 'Requester replied',
    'ticket.resolved': 'Ticket resolved',
    'sla.breached': 'SLA breach',
    'device.alert': 'Device alert',
    offline: 'Device offline',
    low_disk: 'Low disk space',
    session_invite: 'Session invite',
    'session.adhoc.claimed': 'Support code claimed',
    automation: 'Automation',
    'membership.invited': 'Membership invited',
    'service.approval': 'Approval needed',
    'service.approval_decided': 'Approval decided',
    'change.approval': 'Change approval',
    'telephony.call_received': 'Inbound call',
    'chat.message': 'Team chat',
  }
  return labels[kind] ?? kind.replace(/[._]/g, ' ')
}

function notificationTarget(notification: AppNotification): string | null {
  if (!notification.subject_id) return null
  if (notification.subject_type === 'ticket') return `/tickets/${notification.subject_id}`
  if (notification.subject_type === 'device') return `/devices/${notification.subject_id}`
  if (notification.subject_type === 'session' || notification.subject_type === 'remote_session') return `/sessions/${notification.subject_id}`
  if (notification.subject_type === 'chat_room') return '/chat'
  return null
}

function notificationAge(value: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
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
  '/kb': 'kb', '/learn': 'kb', '/automations': 'automations', '/scripts': 'scripts',
  '/assets': 'assets', '/services': 'services', '/incidents': 'incidents', '/patches': 'patches',
  '/reports': 'reports', '/compliance': 'compliance',
  '/chat': 'chat', '/calls': 'calls',
  '/msp': 'msp', '/grants': 'access', '/ai-agent': 'ai', '/integrations': 'integrations',
  '/developer': 'developer', '/marketplace': 'marketplace',
  '/staff': 'staff', '/teams': 'staff', '/support': 'support',
  '/profile': 'profile', '/billing': 'billing', '/settings': 'settings',
}

/** Categorised sidebar navigation, driven by the caller's permissions. */
function NavSections() {
  const auth = useAuth()
  const location = useLocation()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>('.nav-rail .nav-item[aria-current="page"]')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname])
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
        { to: '/learn', label: 'Learn', show: true },
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
        { to: '/teams', label: 'Teams', show: can('member.read') },
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
  const displayName = auth.user?.name?.trim() || auth.user?.email?.split('@')[0] || 'User'
  const [navOpen, setNavOpen] = useState(false)
  const [sessionDock, setSessionDock] = useState<SessionDockEntry | null>(() => readSessionDock())
  const [notesOpen, setNotesOpen] = useState(false)
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  const [quickTicketOpen, setQuickTicketOpen] = useState(false)
  const [showSessionKey, setShowSessionKey] = useState(false)
  const [sessionKey, setSessionKey] = useState<string | null>(null)
  const [sessionKeyId, setSessionKeyId] = useState<string | null>(null)
  const [sessionKeyExpires, setSessionKeyExpires] = useState<string | null>(null)
  const [sessionKeyRecipient, setSessionKeyRecipient] = useState('')
  const [sessionKeyEmailBusy, setSessionKeyEmailBusy] = useState(false)
  const [sessionKeyEmailNotice, setSessionKeyEmailNotice] = useState<string | null>(null)
  const [sessionKeyBusy, setSessionKeyBusy] = useState(false)
  const [sessionKeyError, setSessionKeyError] = useState<string | null>(null)
  const [copiedSessionCode, setCopiedSessionCode] = useState(false)
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const remoteWrapRef = useRef<HTMLDivElement>(null)
  const notificationsWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const refresh = () => setSessionDock(readSessionDock())
    window.addEventListener(sessionDockEventName, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(sessionDockEventName, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  // Close the remote session key flyout when the user clicks outside it.
  useEffect(() => {
    if (!showSessionKey) return
    const onDown = (event: MouseEvent) => {
      if (remoteWrapRef.current && !remoteWrapRef.current.contains(event.target as Node)) {
        setShowSessionKey(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [showSessionKey])

  // Close the notifications dropdown when the user clicks outside it.
  useEffect(() => {
    if (!notificationsOpen) return
    const onDown = (event: MouseEvent) => {
      if (notificationsWrapRef.current && !notificationsWrapRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [notificationsOpen])

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

  const loadNotifications = useCallback(async () => {
    if (!auth.user) return
    setNotificationsLoading(true)
    try {
      const result = await listNotifications()
      setNotifications(result.notifications ?? [])
    } catch {
      // A missing notification permission should not break the console shell.
    } finally {
      setNotificationsLoading(false)
    }
  }, [auth.activeTenantId, auth.user?.id])

  useEffect(() => {
    void loadNotifications()
    const tenantId = auth.activeTenantId
    if (!tenantId || !auth.user) return
    return openNotificationStream({
      tenantId,
      onConnected: () => void loadNotifications(),
      onNotification: (notification) => {
        setNotifications((items) => [notification, ...items.filter((item) => item.id !== notification.id)].slice(0, 100))
      },
    })
  }, [auth.activeTenantId, auth.user?.id, loadNotifications])

  const unreadNotifications = notifications.filter((notification) => !notification.read_at)
  const markNotificationRead = async (id: string) => {
    setNotifications((items) => items.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))
    try {
      await markNotificationsRead({ ids: [id] })
    } catch {
      void loadNotifications()
    }
  }
  const markAllNotificationsRead = async () => {
    if (unreadNotifications.length === 0) return
    setNotifications((items) => items.map((item) => ({ ...item, read_at: item.read_at ?? new Date().toISOString() })))
    try {
      await markNotificationsRead({ all: true })
    } catch {
      void loadNotifications()
    }
  }

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
          <span className="brand">{BRAND.name}</span>
        </div>
        <nav className="nav-items" onClick={() => setNavOpen(false)}>
          <NavSections />
        </nav>
        <div className="nav-footer">
          <span className="etch">{BRAND.name} IT Support OS</span>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <button className="btn btn-ghost btn-sm nav-toggle" onClick={() => setNavOpen((open) => !open)} aria-label="Open navigation" aria-expanded={navOpen}>
            <Icon name="menu" size={18} />
          </button>
          <span className="topbar-org">
            {(auth.memberships.find((m) => m.tenant.id === auth.activeTenantId) ?? auth.memberships[0])?.tenant.name ?? BRAND.name}
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

          <div className="topbar-user-chip" title={auth.user?.email ?? undefined}>
            <span className="topbar-user-avatar" aria-hidden="true">{displayName.slice(0, 1).toUpperCase()}</span>
            <span className="topbar-user-copy"><strong>{displayName}</strong><small>{auth.user?.email ?? ''}</small></span>
          </div>

          {/* Remote Session button + key dropdown */}
          <div className="topbar-remote-wrap" ref={remoteWrapRef}>
            <button
              className="btn btn-remote-session"
              onClick={() => {
                if (showSessionKey) { setShowSessionKey(false); return }
                setSessionKeyBusy(true)
                setShowSessionKey(true)
                setSessionKey(null)
                setSessionKeyId(null)
                setSessionKeyRecipient('')
                setSessionKeyEmailNotice(null)
                setSessionKeyError(null)
                {
                  const remotePerms: string[] = ['view_screen']
                  if (perms.has('remote.control')) {
                    remotePerms.push('control_input', 'clipboard')
                  }
                  if (perms.has('remote.elevated')) {
                    remotePerms.push('terminal', 'elevation', 'file_transfer', 'system_manage')
                  }
                  createAdhocSession({
                    permissions: remotePerms as any,
                    expiresInMin: 10,
                    codeLength: 12,
                  }).then((res) => {
                    setSessionKey(res.code)
                    setSessionKeyId(res.id)
                    setSessionKeyExpires(res.expiresAt)
                  }).catch((err) => {
                    setSessionKey(null)
                    setSessionKeyError(err instanceof Error ? err.message : 'Failed to generate key. Please try again.')
                  }).finally(() => setSessionKeyBusy(false))
                }
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
                    <div className="session-key-actions-row">
                      <button className="btn btn-ghost btn-xs" onClick={() => { navigator.clipboard.writeText(sessionKey).then(() => setCopiedSessionCode(true)); window.setTimeout(() => setCopiedSessionCode(false), 2000) }}><Icon name="copy" size={13} />{copiedSessionCode ? 'Copied' : 'Copy code'}</button>
                      <button className="btn btn-ghost btn-xs" onClick={() => {
                        setSessionKeyBusy(true)
                        setSessionKey(null)
                        setSessionKeyId(null)
                        setSessionKeyRecipient('')
                        setSessionKeyEmailNotice(null)
                        setSessionKeyError(null)
                        {
                          const remotePerms: string[] = ['view_screen']
                          if (perms.has('remote.control')) remotePerms.push('control_input', 'clipboard')
                          if (perms.has('remote.elevated')) remotePerms.push('terminal', 'elevation', 'file_transfer', 'system_manage')
                          createAdhocSession({ permissions: remotePerms as any, expiresInMin: 10, codeLength: 12 })
                            .then((res) => { setSessionKey(res.code); setSessionKeyId(res.id); setSessionKeyExpires(res.expiresAt) })
                            .catch((err) => { setSessionKey(null); setSessionKeyError(err instanceof Error ? err.message : 'Failed to generate key.') })
                            .finally(() => setSessionKeyBusy(false))
                        }
                      }}><Icon name="refresh" size={13} />Refresh</button>
                    </div>
                    <span className="session-key-validity">Valid for 10 minutes · single use</span>
                    <p className="session-key-instructions">Send this 12-digit code to the person you’re helping. They can visit the link below, download the helper, enter the code, and approve the access request on their device.</p>
                    <div className="session-key-connect-url">{window.location.origin}/connect/{sessionKey}</div>
                    <button className="btn btn-ghost btn-xs session-key-copy" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/connect/${sessionKey}`)}>Copy secure link</button>
                    <div className="session-key-email-form">
                      <input className="field-input" type="email" placeholder="Recipient email" value={sessionKeyRecipient} onChange={(event) => setSessionKeyRecipient(event.target.value)} />
                      <button className="btn btn-primary btn-sm" type="button" disabled={!sessionKeyRecipient.trim() || !sessionKeyId || sessionKeyEmailBusy} onClick={() => {
                        if (!sessionKeyId || !sessionKey) return
                        setSessionKeyEmailBusy(true)
                        setSessionKeyEmailNotice(null)
                        void emailAdhocSession(sessionKeyId, sessionKey, sessionKeyRecipient.trim(), 'email_link').then(() => setSessionKeyEmailNotice('Secure link sent.')).catch((err) => setSessionKeyEmailNotice(err instanceof Error ? err.message : 'Could not send email.')).finally(() => setSessionKeyEmailBusy(false))
                      }}><Icon name="mail" size={13} />{sessionKeyEmailBusy ? 'Sending…' : 'Send link'}</button>
                    </div>
                    {sessionKeyEmailNotice ? <span className="session-key-email-notice">{sessionKeyEmailNotice}</span> : null}
                  </>
                ) : (
                  <div className="session-key-error">{sessionKeyError ?? 'Failed to generate key. Please try again.'}</div>
                )}
              </div>
            )}
          </div>

          <button type="button" className="btn btn-new-ticket" onClick={() => setQuickTicketOpen(true)}>
            <Icon name="ticket" size={16} />
            New Ticket
          </button>

          <div className="topbar-icons">
            <div className="topbar-notifications-wrap" ref={notificationsWrapRef}>
              <button
                type="button"
                className="topbar-icon-btn notification-trigger"
                title="Notifications"
                aria-label={unreadNotifications.length ? `${unreadNotifications.length} unread notifications` : 'Notifications'}
                aria-expanded={notificationsOpen}
                onClick={() => {
                  setNotificationsOpen((open) => !open)
                  if (!notificationsOpen) void loadNotifications()
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                {unreadNotifications.length > 0 ? <span className="notification-badge">{unreadNotifications.length > 99 ? '99+' : unreadNotifications.length}</span> : null}
              </button>
              {notificationsOpen ? (
                <div className="notification-dropdown" role="dialog" aria-label="Notifications">
                  <div className="notification-dropdown-head">
                    <div><strong>Notifications</strong><span>{unreadNotifications.length ? `${unreadNotifications.length} unread` : 'All caught up'}</span></div>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => void markAllNotificationsRead()} disabled={unreadNotifications.length === 0}>Mark all read</button>
                  </div>
                  <div className="notification-list">
                    {notificationsLoading && notifications.length === 0 ? <div className="notification-empty">Loading notifications…</div> : null}
                    {!notificationsLoading && notifications.length === 0 ? <div className="notification-empty"><strong>No notifications</strong><span>Ticket updates, alerts, and requests will appear here.</span></div> : null}
                    {notifications.map((notification) => {
                      const target = notificationTarget(notification)
                      const content = <><span className="notification-row-icon"><Icon name={notification.kind.includes('ticket') ? 'ticket' : notification.kind.includes('device') || notification.kind === 'offline' ? 'monitor' : 'alert'} size={14} /></span><span className="notification-row-main"><strong>{notificationLabel(notification.kind)}</strong><span>{notification.body}</span><small>{notificationAge(notification.created_at)}</small></span>{!notification.read_at ? <span className="notification-unread-dot" aria-label="Unread" /> : null}</>
                      return target ? <Link key={notification.id} to={target} className={`notification-row${notification.read_at ? '' : ' unread'}`} onClick={() => void markNotificationRead(notification.id)}>{content}</Link> : <button key={notification.id} type="button" className={`notification-row${notification.read_at ? '' : ' unread'}`} onClick={() => void markNotificationRead(notification.id)}>{content}</button>
                    })}
                  </div>
                </div>
              ) : null}
            </div>
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
            <Icon name="lock" size={16} />
          </button>
          <button
            className="btn btn-ghost btn-sm topbar-icon-btn"
            onClick={() => {
              if (!auth.user) return
              void auth.logout().then(() => navigate('/login'))
            }}
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
            <Link className="btn btn-primary btn-sm" to={`/sessions/${sessionDock.id}`}>
              <Icon name="external" size={14} />Open Console
            </Link>
          </div>
        ) : null}
        <main className="app-content" id="main-content" tabIndex={-1}>{children}</main>
        <QuickTicketModal open={quickTicketOpen} onClose={() => setQuickTicketOpen(false)} />
      </div>
    </div>
  )
}
