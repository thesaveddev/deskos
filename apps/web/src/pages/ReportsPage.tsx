import { useEffect, useState, useMemo } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { STATUS_LABELS } from '../lib/tickets.js'
import { formatMinutes, getTicketReport, getAnalyticsReport, getComplianceReport, type TicketReport, type AnalyticsReport, type ComplianceReport } from '../lib/reports.js'

/* ═══════════════════════════════════════════════════════════════
   SVG Mini-charts (no external dependencies)
   ═══════════════════════════════════════════════════════════════ */

const CHART_COLORS = ['#f59e0b', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

function LineChart({ data, width = 600, height = 200, color = 'var(--accent)', label }: {
  data: Array<{ label: string; value: number }>; width?: number; height?: number; color?: string; label?: string
}) {
  if (data.length === 0) return null
  const pad = { top: 20, right: 20, bottom: 40, left: 50 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const max = Math.max(1, ...data.map((d) => d.value))
  const points = data.map((d, i) => ({
    x: pad.left + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w),
    y: pad.top + h - (d.value / max) * h,
  }))
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaD = `${pathD} L${points[points.length - 1].x},${pad.top + h} L${points[0].x},${pad.top + h} Z`
  const xTicks = data.length <= 10 ? data : data.filter((_, i) => i % Math.ceil(data.length / 8) === 0 || i === data.length - 1)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="report-chart" preserveAspectRatio="xMidYMid meet">
      {label && <text x={pad.left} y={14} className="chart-title">{label}</text>}
      <defs>
        <linearGradient id={`lg-${color.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.2" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {/* Grid lines */}
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={pad.left} y1={pad.top + h * (1 - f)} x2={pad.left + w} y2={pad.top + h * (1 - f)} className="chart-grid" />
          <text x={pad.left - 8} y={pad.top + h * (1 - f) + 4} className="chart-tick" textAnchor="end">{Math.round(max * f)}</text>
        </g>
      ))}
      {/* Area */}
      <path d={areaD} fill={`url(#lg-${color.replace(/[^a-z0-9]/gi, '')})`} />
      {/* Line */}
      <path d={pathD} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill={color} stroke="var(--bg-primary)" strokeWidth="2" />
      ))}
      {/* X labels */}
      {xTicks.map((d, i) => {
        const idx = data.indexOf(d)
        return <text key={i} x={points[idx]?.x ?? 0} y={height - 8} className="chart-tick" textAnchor="middle">{d.label.length > 5 ? d.label.slice(5) : d.label}</text>
      })}
    </svg>
  )
}

function DonutChart({ segments, size = 180, thickness = 28, label }: {
  segments: Array<{ value: number; color: string; label: string }>; size?: number; thickness?: number; label?: string
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return null
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  let acc = 0
  return (
    <div className="donut-wrap">
      {label && <span className="chart-title-text">{label}</span>}
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="report-chart">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
        {segments.map((seg) => {
          const pct = seg.value / total
          const dash = circ * pct
          const dashOff = circ * (1 - acc / total) + circ * 0.25
          acc += seg.value
          return (
            <circle key={seg.label} cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={seg.color} strokeWidth={thickness} strokeDasharray={`${dash} ${circ - dash}`}
              strokeDashoffset={dashOff} strokeLinecap="butt" />
          )
        })}
        <text x={size / 2} y={size / 2 - 6} className="donut-center" textAnchor="middle">{total}</text>
        <text x={size / 2} y={size / 2 + 14} className="donut-sub" textAnchor="middle">total</text>
      </svg>
      <div className="donut-legend">
        {segments.map((seg) => (
          <span key={seg.label} className="donut-legend-item">
            <span className="donut-legend-dot" style={{ background: seg.color }} />
            {seg.label} ({seg.value})
          </span>
        ))}
      </div>
    </div>
  )
}

function HorizontalBarChart({ data, maxValue, color = 'var(--accent)' }: {
  data: Array<{ label: string; value: number; sub?: string }>; maxValue?: number; color?: string
}) {
  const max = maxValue ?? Math.max(1, ...data.map((d) => d.value))
  return (
    <div className="hbar-list">
      {data.map((d) => (
        <div key={d.label} className="hbar-row">
          <span className="hbar-label">{d.label}</span>
          <div className="hbar-track">
            <div className="hbar-fill" style={{ width: `${(d.value / max) * 100}%`, background: color }} />
          </div>
          <span className="hbar-value mono">{d.value}{d.sub ? <span className="hbar-sub"> {d.sub}</span> : null}</span>
        </div>
      ))}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Stat Card
   ═══════════════════════════════════════════════════════════════ */

function StatCard({ label, value, sub, tone = 'default', icon }: {
  label: string; value: string | number; sub?: string; tone?: 'default' | 'ok' | 'crit' | 'warn'; icon?: React.ReactNode
}) {
  return (
    <div className={`report-stat-card stat-${tone}`}>
      <div className="report-stat-header">
        {icon && <span className="report-stat-icon">{icon}</span>}
        <span className="report-stat-label">{label}</span>
      </div>
      <span className="report-stat-value">{value}</span>
      {sub && <span className="report-stat-sub">{sub}</span>}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════════ */

type Tab = 'overview' | 'tickets' | 'agents' | 'sessions' | 'compliance'

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [ticketReport, setTicketReport] = useState<TicketReport | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null)
  const [compliance, setCompliance] = useState<ComplianceReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.allSettled([getTicketReport(), getAnalyticsReport(), getComplianceReport()]).then(([t, a, c]) => {
      if (t.status === 'fulfilled') setTicketReport(t.value)
      if (a.status === 'fulfilled') setAnalytics(a.value)
      if (c.status === 'fulfilled') setCompliance(c.value)
      if (t.status === 'rejected') setError(t.reason instanceof Error ? t.reason.message : 'Failed to load reports')
    })
  }, [])

  const dailyData = useMemo(() => {
    if (!ticketReport) return []
    return ticketReport.createdDaily.map((d) => ({ label: d.day, value: d.n }))
  }, [ticketReport])

  const sessionDailyData = useMemo(() => {
    if (!analytics) return []
    return analytics.sessions.perDay.map((d) => ({ label: d.day, value: d.n }))
  }, [analytics])

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Reports & Analytics</h1>
        <div className="report-tabs">
          {(['overview', 'tickets', 'agents', 'sessions', 'compliance'] as Tab[]).map((t) => (
            <button key={t} className={`report-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {!ticketReport && !error ? <div className="etch" style={{ padding: 24 }}>Loading reports…</div> : null}

      {ticketReport && tab === 'overview' && (
        <div className="report-sections">
          {/* KPI Row */}
          <div className="report-kpi-row">
            <StatCard label="Total tickets" value={ticketReport.totals.total} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>} />
            <StatCard label="Open now" value={ticketReport.totals.open} tone="warn" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
            <StatCard label="Resolved" value={ticketReport.totals.resolved} tone="ok" icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>} />
            <StatCard label="SLA compliance" value={analytics ? `${analytics.sla.complianceRate}%` : '—'} tone={analytics && analytics.sla.complianceRate >= 90 ? 'ok' : 'crit'} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>} />
            <StatCard label="Avg response" value={formatMinutes(ticketReport.firstResponse.avg_minutes)} sub={`${ticketReport.firstResponse.n} responses`} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>} />
            <StatCard label="Avg resolution" value={formatMinutes(ticketReport.resolution.avg_minutes)} sub={`${ticketReport.resolution.n} resolved`} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
          </div>

          {/* Charts Row */}
          <div className="report-charts-row">
            <div className="report-chart-card wide">
              <h3 className="report-card-title">Ticket volume (30 days)</h3>
              <LineChart data={dailyData} color="var(--accent)" />
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">By status</h3>
              <DonutChart
                segments={ticketReport.byStatus.map((s, i) => ({
                  value: s.n, color: CHART_COLORS[i % CHART_COLORS.length], label: STATUS_LABELS[s.status] ?? s.status,
                }))}
              />
            </div>
          </div>

          <div className="report-charts-row">
            <div className="report-chart-card">
              <h3 className="report-card-title">By priority</h3>
              <HorizontalBarChart
                data={ticketReport.byPriority.map((p) => ({ label: p.priority.toUpperCase(), value: p.n }))}
                color="var(--accent)"
              />
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">Agent workload</h3>
              <HorizontalBarChart
                data={ticketReport.byAssignee.slice(0, 8).map((a) => ({ label: a.name, value: a.open_tickets, sub: 'open' }))}
                color="#3b82f6"
              />
            </div>
          </div>
        </div>
      )}

      {ticketReport && tab === 'tickets' && (
        <div className="report-sections">
          <div className="report-charts-row">
            <div className="report-chart-card wide">
              <h3 className="report-card-title">Daily ticket creation trend</h3>
              <LineChart data={dailyData} color="#3b82f6" />
            </div>
          </div>
          <div className="report-charts-row">
            <div className="report-chart-card">
              <h3 className="report-card-title">Status distribution</h3>
              <DonutChart
                segments={ticketReport.byStatus.map((s, i) => ({
                  value: s.n, color: CHART_COLORS[i % CHART_COLORS.length], label: STATUS_LABELS[s.status] ?? s.status,
                }))}
                size={200}
              />
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">Priority breakdown</h3>
              <DonutChart
                segments={ticketReport.byPriority.map((p, i) => ({
                  value: p.n, color: ['#ef4444', '#f59e0b', '#3b82f6', '#10b981'][i] ?? '#999', label: p.priority.toUpperCase(),
                }))}
                size={200}
              />
            </div>
          </div>
          <div className="report-charts-row">
            <div className="report-chart-card">
              <h3 className="report-card-title">SLA performance</h3>
              <div className="report-sla-grid">
                <div className="report-sla-item">
                  <span className="report-sla-num">{formatMinutes(ticketReport.firstResponse.avg_minutes)}</span>
                  <span className="report-sla-label">Avg first response</span>
                </div>
                <div className="report-sla-item">
                  <span className="report-sla-num">{formatMinutes(ticketReport.resolution.avg_minutes)}</span>
                  <span className="report-sla-label">Avg resolution time</span>
                </div>
                <div className="report-sla-item">
                  <span className="report-sla-num report-sla-crit">{ticketReport.totals.breached}</span>
                  <span className="report-sla-label">SLA breaches</span>
                </div>
                <div className="report-sla-item">
                  <span className="report-sla-num report-sla-ok">{ticketReport.totals.resolved}</span>
                  <span className="report-sla-label">Total resolved</span>
                </div>
              </div>
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">Tickets by assignee</h3>
              <HorizontalBarChart
                data={ticketReport.byAssignee.map((a) => ({ label: a.name, value: a.open_tickets, sub: 'open' }))}
                color="#f59e0b"
              />
            </div>
          </div>
        </div>
      )}

      {analytics && ticketReport && tab === 'agents' && (
        <div className="report-sections">
          <div className="report-kpi-row">
            <StatCard label="Active agents" value={analytics.workload.length} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>} />
            <StatCard label="Avg resolution" value={formatMinutes(ticketReport.resolution.avg_minutes)} tone="ok" />
            <StatCard label="Avg response" value={formatMinutes(ticketReport.firstResponse.avg_minutes)} />
          </div>

          <div className="report-chart-card wide">
            <h3 className="report-card-title">Agent performance</h3>
            <div className="agent-perf-table">
              <div className="agent-perf-head">
                <span>Agent</span><span>Open</span><span>Resolved</span><span>Avg resolution</span>
              </div>
              {analytics.workload.map((w) => (
                <div key={w.id} className="agent-perf-row">
                  <span className="agent-perf-name">{w.name}</span>
                  <span className="mono">{w.open}</span>
                  <span className="mono" style={{ color: 'var(--color-ok)' }}>{w.resolved}</span>
                  <span className="mono">{formatMinutes(w.avg_resolution_min)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {analytics && tab === 'sessions' && (
        <div className="report-sections">
          <div className="report-kpi-row">
            <StatCard label="Total sessions" value={analytics.sessions.total} icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>} />
            <StatCard label="Live now" value={analytics.sessions.live} tone={analytics.sessions.live > 0 ? 'ok' : 'default'} />
            <StatCard label="Avg duration" value={formatMinutes(analytics.sessions.avg_duration_min)} />
          </div>

          <div className="report-charts-row">
            <div className="report-chart-card wide">
              <h3 className="report-card-title">Sessions (30 days)</h3>
              <LineChart data={sessionDailyData} color="#8b5cf6" />
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">By type</h3>
              <DonutChart
                segments={analytics.sessions.byType.map((t, i) => ({
                  value: t.n, color: CHART_COLORS[i % CHART_COLORS.length], label: t.type,
                }))}
              />
            </div>
          </div>

          <div className="report-chart-card wide">
            <h3 className="report-card-title">By state</h3>
            <HorizontalBarChart
              data={analytics.sessions.byState.map((s) => ({ label: s.state, value: s.n }))}
              color="#8b5cf6"
            />
          </div>
        </div>
      )}

      {compliance && tab === 'compliance' && (
        <div className="report-sections">
          <div className="report-kpi-row">
            <StatCard
              label="Audit log integrity"
              value={compliance.audit.integrityOk ? 'Intact' : 'Broken'}
              tone={compliance.audit.integrityOk ? 'ok' : 'crit'}
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
            />
            <StatCard label="Audit events (24h)" value={compliance.audit.last24h} sub={`${compliance.audit.total} total`} />
            <StatCard label="JIT grants" value={compliance.jit.total} sub={`${compliance.jit.active} active`} />
            <StatCard label="Recordings" value={compliance.recordings.sessions} sub={`${compliance.recordings.video} video`} />
          </div>

          <div className="report-charts-row">
            <div className="report-chart-card">
              <h3 className="report-card-title">JIT access grants</h3>
              <DonutChart
                segments={[
                  { value: compliance.jit.active, color: '#10b981', label: 'Active' },
                  { value: compliance.jit.approved, color: '#3b82f6', label: 'Approved' },
                  { value: compliance.jit.revoked, color: '#ef4444', label: 'Revoked' },
                ]}
                size={160}
              />
            </div>
            <div className="report-chart-card">
              <h3 className="report-card-title">Session recordings</h3>
              <DonutChart
                segments={[
                  { value: compliance.recordings.video, color: '#8b5cf6', label: 'Video' },
                  { value: compliance.recordings.metadata, color: '#06b6d4', label: 'Metadata' },
                ]}
                size={160}
              />
            </div>
          </div>

          <div className="report-chart-card wide">
            <h3 className="report-card-title">Security summary</h3>
            <div className="report-sla-grid">
              <div className="report-sla-item">
                <span className={`report-sla-num ${compliance.audit.integrityOk ? 'report-sla-ok' : 'report-sla-crit'}`}>
                  {compliance.audit.integrityOk ? '✓' : '✗'}
                </span>
                <span className="report-sla-label">Audit chain integrity</span>
              </div>
              <div className="report-sla-item">
                <span className="report-sla-num">{analytics?.sla.complianceRate ?? '—'}%</span>
                <span className="report-sla-label">SLA compliance rate</span>
              </div>
              <div className="report-sla-item">
                <span className="report-sla-num">{compliance.jit.total}</span>
                <span className="report-sla-label">Privileged access grants</span>
              </div>
              <div className="report-sla-item">
                <span className="report-sla-num">{compliance.recordings.sessions}</span>
                <span className="report-sla-label">Recorded sessions</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}
