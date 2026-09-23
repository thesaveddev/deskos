import { useEffect, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { QuickTicketModal } from '../components/QuickTicketModal.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import { ticketCounts, listTickets, type Ticket } from '../lib/tickets.js'
import { getTicketReport, formatMinutes, type TicketReport } from '../lib/reports.js'
import { listDevices, type Device } from '../lib/devices.js'
import { listSessions, type RemoteSession } from '../lib/sessions.js'
import { listMyApprovals, type Approval } from '../lib/catalogue.js'
import { listIncidents, type MajorIncident } from '../lib/incidents.js'
import { listWarrantyWatch, type WarrantyWatchItem } from '../lib/assets.js'
import { getOnboardingStatus } from '../lib/onboarding.js'
import { listOpenAlerts, type MonitoringAlert } from '../lib/monitoring.js'
import { getAiWorkerMetrics, type AiWorkerMetrics } from '../lib/ai-worker.js'
import { OnboardingWizard } from '../components/OnboardingWizard.js'

/* ── Shared shapes ────────────────────────────────────────────── */

interface TicketCounts {
  mine: number
  unassigned: number
  slaRisk: number
  byStatus: Array<{ status: string; n: number }>
}

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

/* Session states need their own colour mapping — a live session is green,
   a negotiating one blue, waiting for consent yellow. */
function SessionStateDot({ state }: { state: string }) {
  const cls =
    state === 'active' ? 'dot-resolved'
      : state === 'connecting' || state === 'reconnecting' ? 'dot-active'
        : state === 'requested' || state === 'consent_pending' ? 'dot-open'
          : 'dot-closed'
  return <span className={`status-dot ${cls}`} />
}

/* ── Priority badge ────────────────────────────────────────────── */

function PriorityBadge({ p }: { p: string }) {
  return <span className={`priority-badge priority-${p}`}>{p.toUpperCase()}</span>
}

/* ── Renewal date helper ───────────────────────────────────────── */

function daysUntil(date: string | null | undefined): number | null {
  if (!date) return null
  const ms = new Date(`${date.slice(0, 10)}T00:00:00`).getTime() - Date.now()
  return Math.ceil(ms / 86_400_000)
}

/* ── Relative time helper ───────────────────────────────────── */

function timeAgo(date: string | null | undefined): string {
  if (!date) return '—'
  const seconds = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

/* ── Upcoming renewals card ────────────────────────────────────── */

function RenewalsCard({ warranties, licences }: { warranties: WarrantyWatchItem[]; licences: WarrantyWatchItem[] }) {
  const rows = [
    ...warranties.slice(0, 3).map((w) => ({ key: `w-${w.id}`, id: w.id, tag: w.tag ?? '', name: w.name, kind: 'Warranty', due: w.warranty_until ?? null })),
    ...licences.slice(0, 2).map((l) => ({ key: `l-${l.id}`, id: l.id, tag: l.asset_tag ?? '', name: l.name, kind: 'Licence', due: l.expires_at ?? null })),
  ]
    .filter((row) => row.due)
    .sort((a, b) => daysUntil(a.due)! - daysUntil(b.due)!)
    .slice(0, 5)

  return (
    <div className="dash-card dash-renewals-card">
      <div className="dash-card-header">
        <h3 className="dash-card-title">Upcoming renewals</h3>
        <Link to="/assets" className="btn btn-ghost btn-sm">Assets →</Link>
      </div>
      {rows.length > 0 ? (
        <div className="dash-renewals-list">
          {rows.map((row) => {
            const days = daysUntil(row.due)!
            const tone = days < 0 ? 'crit' : days <= 30 ? 'warn' : 'ok'
            return (
              <Link key={row.key} to="/assets" className="dash-renewal-row">
                <span className={`dash-renewal-pill dash-renewal-${tone}`}>{days < 0 ? 'expired' : days <= 30 ? `${days}d` : `${days}d`}</span>
                <span className="dash-renewal-name" title={`${row.tag} · ${row.name}`}>{row.name}</span>
                <span className="dash-renewal-kind">{row.kind}</span>
                <span className="dash-renewal-date mono">{row.due?.slice(0, 10)}</span>
              </Link>
            )
          })}
        </div>
      ) : (
        <p className="dash-empty">Nothing expires in the next 90 days</p>
      )}
    </div>
  )
}

/* ── Renewals KPI card ─────────────────────────────────────────── */

/**
 * Dashboard KPI card for upcoming renewals: total expiring items inside the
 * 90-day watch window, with the urgent subset (30-day window / already
 * expired) broken out. Links into the Assets page's renewals view. Expiry
 * dates muted for email still count here — muting silences notices, not
 * the underlying expiry.
 */
function RenewalsKpi({ renewals }: { renewals: { warranties: WarrantyWatchItem[]; licences: WarrantyWatchItem[] } }) {
  const all = [
    ...renewals.warranties.map((w) => w.warranty_until),
    ...renewals.licences.map((l) => l.expires_at),
  ].filter((d): d is string => Boolean(d))
  const urgent = all.filter((d) => (daysUntil(d) ?? Infinity) <= 30).length

  return (
    <div className="dash-kpi">
      <span className="dash-kpi-value">{all.length}</span>
      <span className="dash-kpi-label">Renewals due (90d)</span>
      {urgent > 0
        ? <Link to="/assets?view=renewals" className="dash-kpi-warn dash-kpi-link">{urgent} urgent · review →</Link>
        : <Link to="/assets?view=renewals" className="dash-kpi-link">Review schedule →</Link>}
    </div>
  )
}

/* ── Needs attention ──────────────────────────────────────── */

function NeedsAttention({ counts, alerts }: {
  counts: TicketCounts | null
  alerts: MonitoringAlert[]
}) {
  const unassigned = counts?.unassigned ?? 0
  const slaRisk = counts?.slaRisk ?? 0
  const openAlerts = alerts.length
  const clear = unassigned === 0 && slaRisk === 0 && openAlerts === 0
  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <h3 className="dash-card-title">Needs attention</h3>
        {clear && <span className="dash-kpi-link" style={{ color: 'var(--ok)' }}>All clear ✓</span>}
      </div>
      <div className="dash-metrics-pair">
        <div className="dash-metric-item">
          <span className="dash-metric-val">{unassigned}</span>
          <span className="dash-metric-label">Unassigned tickets</span>
          <Link to="/tickets" className="dash-kpi-link">Open queue →</Link>
        </div>
        <div className="dash-metric-item">
          <span className={`dash-metric-val${slaRisk > 0 ? ' metric-warn' : ''}`}>{slaRisk}</span>
          <span className="dash-metric-label">SLA risk (breached or &lt; 1h)</span>
          <Link to="/tickets" className="dash-kpi-link">Review →</Link>
        </div>
        <div className="dash-metric-item">
          <span className={`dash-metric-val${openAlerts > 0 ? ' metric-warn' : ''}`}>{openAlerts}</span>
          <span className="dash-metric-label">Open device alerts</span>
          <Link to="/monitoring" className="dash-kpi-link">Investigate →</Link>
        </div>
      </div>
    </div>
  )
}

/* ── Tickets by status ────────────────────────────────────── */

const STATUS_ORDER = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'waiting_user', 'on_hold', 'resolved', 'closed']

function StatusBreakdown({ counts }: { counts: TicketCounts | null }) {
  const rows = [...(counts?.byStatus ?? [])].sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a.status)
    const bi = STATUS_ORDER.indexOf(b.status)
    return (ai === -1 ? STATUS_ORDER.length : ai) - (bi === -1 ? STATUS_ORDER.length : bi)
  })
  const total = rows.reduce((sum, r) => sum + r.n, 0)
  return (
    <div className="dash-card">
      <h3 className="dash-card-title">Tickets by status</h3>
      {rows.length > 0 ? (
        <div className="dash-workload-list">
          {rows.map((r) => (
            <div key={r.status} className="dash-workload-row">
              <span className="dash-workload-name">{r.status.replace(/_/g, ' ')}</span>
              <div className="dash-workload-bar-wrap">
                <div className="dash-workload-bar" style={{ width: `${(r.n / (total || 1)) * 100}%` }} />
              </div>
              <span className="dash-workload-count">{r.n}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="dash-empty">No tickets yet</p>
      )}
    </div>
  )
}

/* ── Open device alerts ──────────────────────────────────── */

function AlertsCard({ alerts }: { alerts: MonitoringAlert[] }) {
  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <h3 className="dash-card-title">Open device alerts{alerts.length > 0 ? ` (${alerts.length})` : ''}</h3>
        <Link to="/monitoring" className="btn btn-ghost btn-sm">View all →</Link>
      </div>
      {alerts.length > 0 ? (
        <div className="device-alert-list">
          {alerts.slice(0, 6).map((a) => (
            <div key={a.id} className="device-alert-row">
              <span className={`alert-severity severity-${a.severity}`} />
              <div className="device-alert-main">
                <strong>{a.message}</strong>
                <span className="dash-session-type">
                  {a.device_name}{a.ticket_number ? ` · #${a.ticket_number}` : ''} · {timeAgo(a.created_at)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="dash-empty">No open alerts — the fleet is quiet</p>
      )}
    </div>
  )
}

/* ── AI worker outcomes ──────────────────────────────────── */

function AiWorkerCard({ metrics }: { metrics: AiWorkerMetrics | null }) {
  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <h3 className="dash-card-title">AI worker</h3>
        <Link to="/ai-workers" className="btn btn-ghost btn-sm">Workers →</Link>
      </div>
      {metrics && metrics.total > 0 ? (
        <>
          <div className="dash-metrics-pair">
            <div className="dash-metric-item">
              <span className="dash-metric-val">{metrics.resolutionRate}%</span>
              <span className="dash-metric-label">Auto-resolved</span>
            </div>
            <div className="dash-metric-item">
              <span className="dash-metric-val">{metrics.total}</span>
              <span className="dash-metric-label">Total runs</span>
            </div>
            <div className="dash-metric-item">
              <span className="dash-metric-val">{formatMinutes(metrics.timeSavedMinutes)}</span>
              <span className="dash-metric-label">Time saved</span>
            </div>
            <div className="dash-metric-item">
              <span className={`dash-metric-val${metrics.escalated > 0 ? ' metric-warn' : ''}`}>{metrics.escalated}</span>
              <span className="dash-metric-label">Escalated to human</span>
            </div>
          </div>
          <p className="dash-empty" style={{ padding: '0.25rem 0 0' }}>
            {metrics.resolved} resolved · {metrics.failed} failed · {Math.round(metrics.avgConfidence * 100)}% avg confidence
          </p>
        </>
      ) : (
        <p className="dash-empty">
          No worker runs yet — <Link to="/ai-workers">set up your first worker →</Link>
        </p>
      )}
    </div>
  )
}

/* ── Live & recent sessions ───────────────────────────────── */

function SessionsCard({ sessions }: { sessions: RemoteSession[] }) {
  return (
    <div className="dash-card">
      <div className="dash-card-header">
        <h3 className="dash-card-title">Live &amp; recent sessions</h3>
        <Link to="/sessions" className="btn btn-ghost btn-sm">View all →</Link>
      </div>
      {sessions.length > 0 ? (
        <div className="dash-session-list">
          {sessions.slice(0, 6).map((s) => (
            <div key={s.id} className="dash-session-row">
              <SessionStateDot state={s.state} />
              <span className="dash-session-device">{s.device_name || s.device_id}</span>
              <span className="dash-session-type">{s.state.replace(/_/g, ' ')}</span>
              <span className="dash-session-type">{timeAgo(s.started_at ?? s.created_at)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="dash-empty">No remote sessions yet</p>
      )}
    </div>
  )
}

/* ── Owner / Manager dashboard ─────────────────────────────────── */

function ManagerDashboard({ report, devices, sessions, incidents, myTicketCount, renewals, counts, alerts, aiMetrics }: {
  report: TicketReport | null
  devices: Device[]
  sessions: RemoteSession[]
  incidents: MajorIncident[]
  myTicketCount: number
  renewals: { warranties: WarrantyWatchItem[]; licences: WarrantyWatchItem[] }
  counts: TicketCounts | null
  alerts: MonitoringAlert[]
  aiMetrics: AiWorkerMetrics | null
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
        <RenewalsKpi renewals={renewals} />
      </div>

      {/* Unassigned / SLA risk / open alerts — the work that can't wait */}
      <NeedsAttention counts={counts} alerts={alerts} />

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

      {/* Status breakdown + open device alerts */}
      <div className="dash-grid-2">
        <StatusBreakdown counts={counts} />
        <AlertsCard alerts={alerts} />
      </div>

      {/* AI worker outcomes + live sessions */}
      <div className="dash-grid-2">
        <AiWorkerCard metrics={aiMetrics} />
        <SessionsCard sessions={sessions} />
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

      {/* Upcoming warranty / licence renewals */}
      {(renewals.warranties.length > 0 || renewals.licences.length > 0) && (
        <RenewalsCard warranties={renewals.warranties} licences={renewals.licences} />
      )}
    </>
  )
}

/* ── Analyst / Engineer dashboard ──────────────────────────────── */

function AnalystDashboard({ myTickets, report, devices, sessions, renewals, counts, alerts, aiMetrics }: {
  myTickets: Ticket[]
  report: TicketReport | null
  devices: Device[]
  sessions: RemoteSession[]
  renewals: { warranties: WarrantyWatchItem[]; licences: WarrantyWatchItem[] }
  counts: TicketCounts | null
  alerts: MonitoringAlert[]
  aiMetrics: AiWorkerMetrics | null
}) {
  const activeSessions = sessions.filter((s) => s.state === 'active' || s.state === 'connecting' || s.state === 'consent_pending').length
  const actionable = (t: Ticket) => t.status !== 'resolved' && t.status !== 'closed'

  return (
    <>
      <div className="dash-kpi-row">
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.filter(actionable).length}</span>
          <span className="dash-kpi-label">Assigned to you</span>
          <Link to="/tickets" className="dash-kpi-link">View queue →</Link>
        </div>
        <div className="dash-kpi">
          <span className="dash-kpi-value">{myTickets.filter((t) => actionable(t) && (t.priority === 'critical' || t.priority === 'high')).length}</span>
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
        <RenewalsKpi renewals={renewals} />
      </div>

      {/* Unassigned / SLA risk / open alerts — the work that can't wait */}
      <NeedsAttention counts={counts} alerts={alerts} />

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
                <SessionStateDot state={s.state} />
                <span className="dash-session-device">{s.device_name || s.device_id}</span>
                <span className="dash-session-type">{s.state.replace(/_/g, ' ')}</span>
                <span className="dash-session-type">{timeAgo(s.started_at ?? s.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Open device alerts + AI worker outcomes */}
      <div className="dash-grid-2">
        <AlertsCard alerts={alerts} />
        <AiWorkerCard metrics={aiMetrics} />
      </div>

      {/* Upcoming warranty / licence renewals */}
      {(renewals.warranties.length > 0 || renewals.licences.length > 0) && (
        <RenewalsCard warranties={renewals.warranties} licences={renewals.licences} />
      )}
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
            <button type="button" className="btn btn-primary btn-sm" onClick={onNewTicket}><Icon name="add" size={14} />New ticket</button>
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
  const [renewals, setRenewals] = useState<{ warranties: WarrantyWatchItem[]; licences: WarrantyWatchItem[] }>({ warranties: [], licences: [] })
  const [alerts, setAlerts] = useState<MonitoringAlert[]>([])
  const [aiMetrics, setAiMetrics] = useState<AiWorkerMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [quickTicketOpen, setQuickTicketOpen] = useState(false)
  const [showOnboarding, setShowOnboarding] = useState(false)

  const myRole = useMemo(() => {
    return auth.memberships.find((m) => m.tenant.id === auth.activeTenantId)?.orgRole || 'end_user'
  }, [auth.memberships, auth.activeTenantId])

  const isMgr = isManager(myRole)
  const isAnalystRole = isAnalyst(myRole)
  const perms = auth.memberships.find((m) => m.tenant.id === auth.activeTenantId)?.permissions ?? []
  // Renewals need asset read permission; end users never see the panels.
  const canSeeAssets = perms.includes('asset.read')
  const canSeeDevices = perms.includes('device.read')
  const canSeeAi = perms.includes('ai_agent.read')

  useEffect(() => {
    if (!auth.user) return

    const loadDashboard = async () => {
      setLoading(true)
      try {
        const results = await Promise.allSettled([
          ticketCounts(),
          getTicketReport(),
          // All of my tickets (any status) — each dashboard derives its own
          // open/resolved slices so the KPIs aren't stuck at zero.
          listTickets({ assignee: 'me', limit: '25' }),
          listDevices({ limit: 10 }),
          listSessions({ limit: 10 }),
          listIncidents(),
          listMyApprovals(),
          canSeeAssets ? listWarrantyWatch(90).catch(() => ({ warranties: [], licences: [] })) : Promise.resolve({ warranties: [], licences: [] }),
          canSeeDevices ? listOpenAlerts().catch(() => ({ alerts: [] as MonitoringAlert[] })) : Promise.resolve({ alerts: [] as MonitoringAlert[] }),
          canSeeAi ? getAiWorkerMetrics().catch(() => ({ metrics: null as AiWorkerMetrics | null })) : Promise.resolve({ metrics: null as AiWorkerMetrics | null }),
        ])

        if (results[0].status === 'fulfilled') setCounts(results[0].value as any)
        // Guard the shape: a malformed or partial report payload must degrade
        // to "no report" rather than crash the whole dashboard on report.totals.
        const reportValue = results[1].status === 'fulfilled' ? (results[1].value as TicketReport | null) : null
        if (reportValue && reportValue.totals && reportValue.resolution && reportValue.firstResponse) setReport(reportValue)
        if (results[2].status === 'fulfilled') setMyTickets((results[2].value as any).tickets || [])
        if (results[3].status === 'fulfilled') setDevices((results[3].value as any).devices || [])
        if (results[4].status === 'fulfilled') setSessions((results[4].value as any).sessions || [])
        if (results[5].status === 'fulfilled') setIncidents((results[5].value as any).incidents || [])
        if (results[6].status === 'fulfilled') setApprovals((results[6].value as any).approvals || [])
        if (results[7].status === 'fulfilled') {
          const watchValue = results[7].value as { warranties?: WarrantyWatchItem[]; licences?: WarrantyWatchItem[] } | null
          setRenewals({ warranties: watchValue?.warranties ?? [], licences: watchValue?.licences ?? [] })
        }
        if (results[8].status === 'fulfilled') {
          setAlerts(((results[8].value as { alerts?: MonitoringAlert[] })?.alerts) ?? [])
        }
        if (results[9].status === 'fulfilled') {
          setAiMetrics(((results[9].value as { metrics?: AiWorkerMetrics | null })?.metrics) ?? null)
        }

        // Check onboarding status. The wizard walks through inviting staff,
        // deploying the helper, and configuring AI workers — staff-only
        // actions, so end users never see it.
        if (isMgr || isAnalystRole) {
          try {
            const onboarding = await getOnboardingStatus()
            if (!onboarding.completed) setShowOnboarding(true)
          } catch { /* ignore */
          }
        }
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
          renewals={renewals}
          counts={counts}
          alerts={alerts}
          aiMetrics={aiMetrics}
        />
      ) : isAnalystRole ? (
        <AnalystDashboard
          myTickets={myTickets}
          report={report}
          devices={devices}
          sessions={sessions}
          renewals={renewals}
          counts={counts}
          alerts={alerts}
          aiMetrics={aiMetrics}
        />
      ) : (
        <EndUserDashboard myTickets={myTickets} onNewTicket={() => setQuickTicketOpen(true)} />
      )}
      <QuickTicketModal open={quickTicketOpen} onClose={() => setQuickTicketOpen(false)} />
      {showOnboarding && <OnboardingWizard onComplete={() => setShowOnboarding(false)} />}
    </Shell>
  )
}
