import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { QuickTicketModal } from '../components/QuickTicketModal.js'
import { useAuth } from '../lib/auth.js'
import { ticketCounts, listTickets, type Ticket } from '../lib/tickets.js'
import { getTicketReport, formatMinutes, type TicketReport } from '../lib/reports.js'
import { listDevices, type Device } from '../lib/devices.js'
import { listSessions, type RemoteSession } from '../lib/sessions.js'
import { listMyApprovals, type Approval } from '../lib/catalogue.js'
import { listIncidents, type MajorIncident } from '../lib/incidents.js'

/* ── Role helpers ──────────────────────────────────────────────── */

function isManager(role: string) {
  return ['owner', 'it_manager', 'service_desk_manager'].includes(role)
}

function isAnalyst(role: string) {
  return ['analyst', 'desktop_engineer', 'infrastructure_engineer', 'security_analyst'].includes(role)
}

/* ── Tiny sparkline (SVG) ──────────────────────────────────────── */

function SparkLine({ data, color = 'var(--accent)' }: { data: number[]; color?: string }) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const w = 120
  const h = 32
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (v / max) * h}`).join(' ')
  return (
    <svg width={w} height={h} className="dash-spark">
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
    </svg>
  )
}

/* ── Status dot ────────────────────────────────────────────────── */

function StatusDot({ status }: { status: string }) {
  const cls = status === 'open' ? 'dot-open' : status === 'in_progress' ? 'dot-active' : status === 'resolved' ? 'dot-resolved' : 'dot-closed'
  return <span className={`status-dot ${cls}`} />
}

/* ── Priority badge ────────────────────────────────────────────── */

function PriorityBadge({ p }: { p: string }) {
  return <span className={`priority-badge priority-${p}`}>{p.toUpperCase()}</span>
}

/* ── Owner / Manager dashboard ─────────────────────────────────── */

function ManagerDashboard({ report, devices, sessions, incidents, myTicketCount }: {
  report: TicketReport | null
  devices: Device[]
  sessions: RemoteSession[]
  incidents: MajorIncident[]
  myTicketCount: number
}) {
  const onlineDevices = devices.filter((d) => d.status === 'online').length
  const activeSessions = sessions.filter((s) => s.state === 'active' || s.state === 'connecting' || s.state === 'consent_pending').length

  return (
    <>
      {/* KPI row */}
      <div className="dash-kpi-row">
        <div className="dash-kpi">
          <span className="dash-kpi-value">{report?.totals.open ?? '—'}</span>
          <span className="dash-kpi-label">Open tickets</span>
          <Link to="/tickets" className="dash-kpi-link">View queue →</Link>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{report?.totals.breached ?? 0}</span>
          <span className="dash-kpi-label">SLA breaches</span>
          {report && report.totals.breached > 0 && <span className="dash-kpi-warn">Needs attention</span>}
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{onlineDevices}/{devices.length}</span>
          <span className="dash-kpi-label">Devices online</span>
          <Link to="/devices" className="dash-kpi-link">Manage →</Link>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{activeSessions}</span>
          <span className="dash-kpi-label">Active sessions</span>
          <Link to="/sessions" className="dash-kpi-link">View →</Link>
        </div>
      </div>

      {/* Second row */}
      <div className="dash-grid-2">
        {/* Ticket trend */}
        <div className="dash-card">
          <h3 className="dash-card-title">Tickets created (last 14 days)</h3>
          {report && report.createdDaily.length > 0 ? (
            <div className="dash-trend">
              <SparkLine data={report.createdDaily.map((d) => d.n)} />
              <span className="dash-trend-val">{report.totals.total} total</span>
            </div>
          ) : (
            <p className="dash-empty">No ticket data yet</p>
          )}
        </div>

        {/* Resolution time */}
        <div className="dash-card">
          <h3 className="dash-card-title">Response & resolution</h3>
          <div className="dash-metrics-pair">
            <div className="dash-metric-item">
              <span className="dash-metric-val">{report ? formatMinutes(report.firstResponse.avg_minutes) : '—'}</span>
              <span className="dash-metric-label">Avg first response</span>
            </div>
            <div className="dash-metric-item">
              <span className="dash-metric-val">{report ? formatMinutes(report.resolution.avg_minutes) : '—'}</span>
              <span className="dash-metric-label">Avg resolution</span>
            </div>
          </div>
        </div>
      </div>

      {/* Team workload + SLA breakdown */}
      <div className="dash-grid-2">
        <div className="dash-card">
          <h3 className="dash-card-title">Team workload</h3>
          {report && report.byAssignee.length > 0 ? (
            <div className="dash-workload-list">
              {report.byAssignee.slice(0, 8).map((a) => (
                <div key={a.id} className="dash-workload-row">
                  <span className="dash-workload-name">{a.name}</span>
                  <div className="dash-workload-bar-wrap">
                    <div className="dash-workload-bar" style={{ width: `${Math.min((a.open_tickets / (report.totals.open || 1)) * 100, 100)}%` }} />
                  </div>
                  <span className="dash-workload-count">{a.open_tickets}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="dash-empty">No assignments yet</p>
          )}
        </div>

        <div className="dash-card">
          <h3 className="dash-card-title">By priority</h3>
          {report && report.byPriority.length > 0 ? (
            <div className="dash-priority-list">
              {report.byPriority.map((p) => (
                <div key={p.priority} className="dash-priority-row">
                  <PriorityBadge p={p.priority} />
                  <div className="dash-priority-bar-wrap">
                    <div className="dash-priority-bar" style={{ width: `${(p.n / (report.totals.total || 1)) * 100}%` }} />
                  </div>
                  <span className="dash-priority-count">{p.n}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="dash-empty">No tickets</p>
          )}
        </div>
      </div>

      {/* Incidents */}
      {incidents.length > 0 && (
        <div className="dash-card">
          <h3 className="dash-card-title">Active incidents</h3>
          <div className="dash-incident-list">
            {incidents.slice(0, 5).map((inc) => (
              <Link key={inc.id} to={`/incidents`} className="dash-incident-row">
                <StatusDot status={inc.status} />
                <span className="dash-incident-name">{inc.subject}</span>
                <span className={`severity-badge severity-${inc.severity}`}>{inc.severity}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

/* ── Analyst / Engineer dashboard ──────────────────────────────── */

function AnalystDashboard({ myTickets, report, devices, sessions }: {
  myTickets: Ticket[]
  report: TicketReport | null
  devices: Device[]
  sessions: RemoteSession[]
}) {
  const activeSessions = sessions.filter((s) => s.state === 'active' || s.state === 'connecting' || s.state === 'consent_pending').length

  return (
    <>
      <div className="dash-kpi-row">
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.length}</span>
          <span className="dash-kpi-label">Assigned to you</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.filter((t) => t.priority === 'critical' || t.priority === 'high').length}</span>
          <span className="dash-kpi-label">High priority</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{activeSessions}</span>
          <span className="dash-kpi-label">Active sessions</span>
          <Link to="/sessions" className="dash-kpi-link">View →</Link>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{report ? formatMinutes(report.resolution.avg_minutes) : '—'}</span>
          <span className="dash-kpi-label">Avg resolution time</span>
        </div>
      </div>

      {/* My tickets */}
      <div className="dash-card">
        <div className="dash-card-header">
          <h3 className="dash-card-title">Your tickets</h3>
          <Link to="/tickets" className="btn btn-ghost btn-sm">View all →</Link>
        </div>
        {myTickets.length > 0 ? (
          <div className="dash-ticket-list">
            {myTickets.slice(0, 10).map((t) => (
              <Link key={t.id} to={`/tickets/${t.id}`} className="dash-ticket-row">
                <StatusDot status={t.status} />
                <span className="dash-ticket-subject">{t.subject}</span>
                <PriorityBadge p={t.priority} />
                <span className="dash-ticket-time">{new Date(t.updated_at).toLocaleDateString()}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="dash-empty">No tickets assigned to you</p>
        )}
      </div>

      {/* Recent devices */}
      <div className="dash-grid-2">
        <div className="dash-card">
          <h3 className="dash-card-title">Devices</h3>
          <div className="dash-device-list">
            {devices.slice(0, 6).map((d) => (
              <div key={d.id} className="dash-device-row">
                <StatusDot status={d.status} />
                <span className="dash-device-name">{d.name}</span>
                <span className="dash-device-os">{d.os}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dash-card">
          <h3 className="dash-card-title">Recent sessions</h3>
          <div className="dash-session-list">
            {sessions.slice(0, 6).map((s) => (
              <div key={s.id} className="dash-session-row">
                <StatusDot status={s.state} />
                <span className="dash-session-device">{s.device_name || s.device_id}</span>
                <span className="dash-session-type">{s.type}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

/* ── End User dashboard ────────────────────────────────────────── */

function EndUserDashboard({ myTickets, onNewTicket }: { myTickets: Ticket[]; onNewTicket: () => void }) {
  return (
    <>
      <div className="dash-kpi-row">
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.filter((t) => t.status === 'open' || t.status === 'in_progress').length}</span>
          <span className="dash-kpi-label">Open tickets</span>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.filter((t) => t.status === 'resolved').length}</span>
          <span className="dash-kpi-label">Resolved</span>
        </div>
      </div>

      <div className="dash-grid-2">
        {/* My tickets */}
        <div className="dash-card">
          <div className="dash-card-header">
            <h3 className="dash-card-title">Your recent tickets</h3>
            <button type="button" className="btn btn-primary btn-sm" onClick={onNewTicket}>New ticket</button>
          </div>
          {myTickets.length > 0 ? (
            <div className="dash-ticket-list">
              {myTickets.slice(0, 8).map((t) => (
                <Link key={t.id} to={`/tickets/${t.id}`} className="dash-ticket-row">
                  <StatusDot status={t.status} />
                  <span className="dash-ticket-subject">{t.subject}</span>
                  <span className="dash-ticket-time">{new Date(t.updated_at).toLocaleDateString()}</span>
                </Link>
              ))}
            </div>
          ) : (
            <div className="dash-empty-state">
              <p>No tickets yet</p>
              <button type="button" className="btn btn-primary" onClick={onNewTicket}>Submit a request</button>
            </div>
          )}
        </div>

        {/* Quick links */}
        <div className="dash-card">
          <h3 className="dash-card-title">Quick links</h3>
          <div className="dash-quick-links">
            <Link to="/tickets/new" className="dash-quick-link">
              <span className="dash-quick-icon">🎫</span>
              <span>Submit a request</span>
            </Link>
            <Link to="/kb" className="dash-quick-link">
              <span className="dash-quick-icon">📚</span>
              <span>Knowledge base</span>
            </Link>
            <Link to="/services" className="dash-quick-link">
              <span className="dash-quick-icon">🛒</span>
              <span>Service catalogue</span>
            </Link>
            <Link to="/support" className="dash-quick-link">
              <span className="dash-quick-icon">💬</span>
              <span>ReyDesk support</span>
            </Link>
          </div>
        </div>
      </div>
    </>
  )
}

/* ── Main Dashboard ────────────────────────────────────────────── */

export default function HomePage() {
  const auth = useAuth()
  const [counts, setCounts] = useState<{ mine: number; unassigned: number; slaRisk: number; byStatus: Array<{ status: string; n: number }> } | null>(null)
  const [report, setReport] = useState<TicketReport | null>(null)
  const [myTickets, setMyTickets] = useState<Ticket[]>([])
  const [devices, setDevices] = useState<Device[]>([])
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [incidents, setIncidents] = useState<MajorIncident[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [loading, setLoading] = useState(true)
  const [quickTicketOpen, setQuickTicketOpen] = useState(false)

  const myRole = useMemo(() => {
    return auth.memberships.find((m) => m.tenant.id === auth.activeTenantId)?.orgRole || 'end_user'
  }, [auth.memberships, auth.activeTenantId])

  const isMgr = isManager(myRole)
  const isAnalystRole = isAnalyst(myRole)

  useEffect(() => {
    if (!auth.user) return

    const loadDashboard = async () => {
      setLoading(true)
      try {
        const results = await Promise.allSettled([
          ticketCounts(),
          getTicketReport(),
          listTickets({ status: 'open', assignee: 'me', limit: '10' }),
          listDevices({ limit: 10 }),
          listSessions({ limit: 10 }),
          listIncidents(),
          listMyApprovals(),
        ])

        if (results[0].status === 'fulfilled') setCounts(results[0].value as any)
        if (results[1].status === 'fulfilled') setReport(results[1].value as TicketReport)
        if (results[2].status === 'fulfilled') setMyTickets((results[2].value as any).tickets || [])
        if (results[3].status === 'fulfilled') setDevices((results[3].value as any).devices || [])
        if (results[4].status === 'fulfilled') setSessions((results[4].value as any).sessions || [])
        if (results[5].status === 'fulfilled') setIncidents((results[5].value as any).incidents || [])
        if (results[6].status === 'fulfilled') setApprovals((results[6].value as any).approvals || [])
      } catch {
        /* partial load is fine */
      } finally {
        setLoading(false)
      }
    }

    loadDashboard()
  }, [auth.user, auth.activeTenantId])

  if (!auth.user) return null

  const greeting = () => {
    const h = new Date().getHours()
    if (h < 12) return 'Good morning'
    if (h < 17) return 'Good afternoon'
    return 'Good evening'
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">{greeting()}, {auth.user.name.split(' ')[0]}.</h1>
        <p className="page-subtitle">Here's what's happening across your IT estate.</p>
      </div>

      {/* Pending approvals callout (for managers) */}
      {isMgr && approvals.length > 0 && (
        <div className="dash-approval-callout">
          <span className="dash-approval-icon">⏳</span>
          <span>{approvals.length} approval{approvals.length !== 1 ? 's' : ''} waiting for you</span>
          <Link to="/approvals" className="btn btn-primary btn-sm">Review →</Link>
        </div>
      )}

      {loading ? (
        <div className="dash-loading">
          <div className="loading-spinner" />
          <p>Loading dashboard…</p>
        </div>
      ) : isMgr ? (
        <ManagerDashboard
          report={report}
          devices={devices}
          sessions={sessions}
          incidents={incidents}
          myTicketCount={counts?.mine ?? 0}
        />
      ) : isAnalystRole ? (
        <AnalystDashboard
          myTickets={myTickets}
          report={report}
          devices={devices}
          sessions={sessions}
        />
      ) : (
        <EndUserDashboard myTickets={myTickets} onNewTicket={() => setQuickTicketOpen(true)} />
      )}
      <QuickTicketModal open={quickTicketOpen} onClose={() => setQuickTicketOpen(false)} />
    </Shell>
  )
}
