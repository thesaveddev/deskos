import { useEffect, useState, useMemo, useCallback } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { STATUS_LABELS } from '../lib/tickets.js'
import {
  getOverviewReport, getTicketReport, getAnalyticsReport, getComplianceReport,
  getAiWorkerTimeSeries,
  formatMinutes, exportCSV, exportJSON, exportHTML, printReport,
  type OverviewReport, type TicketReport, type AnalyticsReport, type ComplianceReport,
  type AiWorkerTimeSeries,
} from '../lib/reports.js'

/* ═══════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════ */

const COLORS = ['#e8a33d', '#3b82f6', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#a855f7']
const STATUS_COLORS: Record<string, string> = {
  new: '#3b82f6', open: '#3b82f6', in_progress: '#e8a33d', pending_user: '#f59e0b',
  pending_vendor: '#f59e0b', escalated: '#ef4444', resolved: '#10b981', closed: '#6b7280',
}
const PRIORITY_COLORS: Record<string, string> = { p1: '#ef4444', p2: '#f59e0b', p3: '#3b82f6', p4: '#10b981' }
const PRIORITY_LABELS: Record<string, string> = { p1: 'Critical', p2: 'High', p3: 'Medium', p4: 'Low' }

type Tab = 'overview' | 'tickets' | 'agents' | 'sessions' | 'csat' | 'compliance' | 'ai-workers'
type DatePreset = 'today' | '7d' | '30d' | '90d' | 'all' | 'custom'

function dateRange(preset: DatePreset, customFrom?: string, customTo?: string): { from?: string; to?: string } {
  const now = new Date()
  const end = now.toISOString()
  switch (preset) {
    case 'today': {
      const start = new Date(now); start.setHours(0, 0, 0, 0)
      return { from: start.toISOString(), to: end }
    }
    case '7d': {
      const from = new Date(now); from.setDate(from.getDate() - 7)
      return { from: from.toISOString(), to: end }
    }
    case '30d': {
      const from = new Date(now); from.setDate(from.getDate() - 30)
      return { from: from.toISOString(), to: end }
    }
    case '90d': {
      const from = new Date(now); from.setDate(from.getDate() - 90)
      return { from: from.toISOString(), to: end }
    }
    case 'all': return {}
    case 'custom': return { from: customFrom, to: customTo }
  }
}

/* ═══════════════════════════════════════════════════════════════
   SVG Charts
   ═══════════════════════════════════════════════════════════════ */

function LineChart({ data, width = 700, height = 220, color = 'var(--accent)', label, showArea = true, showDots = true }: {
  data: Array<{ label: string; value: number }>; width?: number; height?: number; color?: string; label?: string; showArea?: boolean; showDots?: boolean
}) {
  if (data.length === 0) return <div className="report-empty">No data available</div>
  const pad = { top: 24, right: 16, bottom: 44, left: 56 }
  const w = width - pad.left - pad.right
  const h = height - pad.top - pad.bottom
  const max = Math.max(1, ...data.map(d => d.value))
  const points = data.map((d, i) => ({
    x: pad.left + (data.length === 1 ? w / 2 : (i / (data.length - 1)) * w),
    y: pad.top + h - (d.value / max) * h,
  }))
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const areaD = `${pathD} L${points[points.length - 1].x},${pad.top + h} L${points[0].x},${pad.top + h} Z`
  const gradId = `grad-${color.replace(/[^a-z0-9]/gi, '')}-${label ?? 'main'}`
  const ticks = data.length <= 12 ? data : data.filter((_, i) => i % Math.ceil(data.length / 10) === 0 || i === data.length - 1)
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="rpt-chart" preserveAspectRatio="xMidYMid meet">
      {label && <text x={pad.left} y={16} className="rpt-chart-title">{label}</text>}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.15" />
          <stop offset="100%" stopColor={color} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map(f => (
        <g key={f}>
          <line x1={pad.left} y1={pad.top + h * (1 - f)} x2={pad.left + w} y2={pad.top + h * (1 - f)} className="rpt-grid" />
          <text x={pad.left - 8} y={pad.top + h * (1 - f) + 4} className="rpt-tick" textAnchor="end">{Math.round(max * f)}</text>
        </g>
      ))}
      {showArea && <path d={areaD} fill={`url(#${gradId})`} />}
      <path d={pathD} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      {showDots && points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill={color} stroke="var(--bg-1)" strokeWidth="2" />
      ))}
      {ticks.map((d, i) => {
        const idx = data.indexOf(d)
        return <text key={i} x={points[idx]?.x ?? 0} y={height - 10} className="rpt-tick" textAnchor="middle">{d.label.length > 5 ? d.label.slice(5) : d.label}</text>
      })}
    </svg>
  )
}

function DonutChart({ segments, size = 180, thickness = 28, label }: {
  segments: Array<{ value: number; color: string; label: string }>; size?: number; thickness?: number; label?: string
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return <div className="report-empty">No data</div>
  const r = (size - thickness) / 2
  const circ = 2 * Math.PI * r
  let acc = 0
  return (
    <div className="rpt-donut-wrap">
      {label && <span className="rpt-card-subtitle">{label}</span>}
      <div className="rpt-donut-inner">
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="rpt-chart">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-1)" strokeWidth={thickness} />
          {segments.map(seg => {
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
          <text x={size / 2} y={size / 2 - 6} className="rpt-donut-center" textAnchor="middle">{total}</text>
          <text x={size / 2} y={size / 2 + 14} className="rpt-donut-sub" textAnchor="middle">total</text>
        </svg>
        <div className="rpt-donut-legend">
          {segments.map(seg => (
            <span key={seg.label} className="rpt-legend-item">
              <span className="rpt-legend-dot" style={{ background: seg.color }} />
              {seg.label} <span className="rpt-legend-count">({seg.value})</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function BarChart({ data, color = 'var(--accent)', horizontal = true }: {
  data: Array<{ label: string; value: number; sub?: string; color?: string }>; color?: string; horizontal?: boolean
}) {
  const max = Math.max(1, ...data.map(d => d.value))
  if (horizontal) {
    return (
      <div className="rpt-hbar">
        {data.map(d => (
          <div key={d.label} className="rpt-hbar-row">
            <span className="rpt-hbar-label">{d.label}</span>
            <div className="rpt-hbar-track">
              <div className="rpt-hbar-fill" style={{ width: `${(d.value / max) * 100}%`, background: d.color ?? color }} />
            </div>
            <span className="rpt-hbar-value mono">{d.value}{d.sub ? <span className="rpt-hbar-sub"> {d.sub}</span> : null}</span>
          </div>
        ))}
      </div>
    )
  }
  // Vertical bars
  return (
    <div className="rpt-vbar">
      {data.map(d => (
        <div key={d.label} className="rpt-vbar-col">
          <span className="rpt-vbar-value mono">{d.value}</span>
          <div className="rpt-vbar-track">
            <div className="rpt-vbar-fill" style={{ height: `${(d.value / max) * 100}%`, background: d.color ?? color }} />
          </div>
          <span className="rpt-vbar-label">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

function HeatmapChart({ data, width = 700, label }: {
  data: Array<{ hour: number; n: number }>; width?: number; label?: string
}) {
  const max = Math.max(1, ...data.map(d => d.n))
  const cellW = (width - 80) / 24
  const cellH = 32
  return (
    <div className="rpt-heatmap-wrap">
      {label && <span className="rpt-card-subtitle">{label}</span>}
      <svg viewBox={`0 0 ${width} ${cellH + 40}`} className="rpt-chart" preserveAspectRatio="xMidYMid meet">
        {Array.from({ length: 24 }, (_, h) => {
          const d = data.find(x => x.hour === h)
          const n = d?.n ?? 0
          const intensity = max > 0 ? n / max : 0
          const r = Math.round(232 * intensity + 26 * (1 - intensity))
          const g = Math.round(163 * intensity + 32 * (1 - intensity))
          const b = Math.round(61 * intensity + 39 * (1 - intensity))
          return (
            <g key={h}>
              <rect x={80 + h * cellW} y={4} width={cellW - 2} height={cellH} rx={4}
                fill={`rgb(${r},${g},${b})`} opacity={0.2 + intensity * 0.8} />
              <text x={80 + h * cellW + cellW / 2} y={cellH + 20} className="rpt-tick" textAnchor="middle" fontSize="10">{h}</text>
              <text x={80 + h * cellW + cellW / 2} y={cellH / 2 + 8} className="rpt-heatmap-val" textAnchor="middle"
                fill={intensity > 0.5 ? '#fff' : 'var(--text-2)'} fontSize="11">{n}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

function TrendIndicator({ value, label }: { value: number; label?: string }) {
  const isPositive = value > 0
  const isNegative = value < 0
  return (
    <span className={`rpt-trend ${isPositive ? 'rpt-trend-up' : isNegative ? 'rpt-trend-down' : 'rpt-trend-flat'}`}>
      {isPositive ? '↑' : isNegative ? '↓' : '→'} {Math.abs(value).toFixed(1)}%{label ? ` ${label}` : ''}
    </span>
  )
}

function StatCard({ label, value, sub, tone = 'default', icon, trend }: {
  label: string; value: string | number; sub?: string; tone?: 'default' | 'ok' | 'crit' | 'warn' | 'info'; icon?: React.ReactNode; trend?: number
}) {
  return (
    <div className={`rpt-stat rpt-stat-${tone}`}>
      <div className="rpt-stat-head">
        {icon && <span className="rpt-stat-icon">{icon}</span>}
        <span className="rpt-stat-label">{label}</span>
      </div>
      <div className="rpt-stat-body">
        <span className="rpt-stat-value">{value}</span>
        {trend !== undefined && <TrendIndicator value={trend} />}
      </div>
      {sub && <span className="rpt-stat-sub">{sub}</span>}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Export Helpers
   ═══════════════════════════════════════════════════════════════ */

function ExportMenu({ onExport }: { onExport: (format: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rpt-export-wrap">
      <button className="btn btn-ghost btn-sm" onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export
      </button>
      {open && (
        <div className="rpt-export-dropdown">
          <button onClick={() => { onExport('csv'); setOpen(false) }}>CSV Spreadsheet</button>
          <button onClick={() => { onExport('json'); setOpen(false) }}>JSON Data</button>
          <button onClick={() => { onExport('html'); setOpen(false) }}>HTML Report</button>
          <button onClick={() => { onExport('print'); setOpen(false) }}>Print / PDF</button>
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Main Page
   ═══════════════════════════════════════════════════════════════ */

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('overview')
  const [datePreset, setDatePreset] = useState<DatePreset>('30d')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [overview, setOverview] = useState<OverviewReport | null>(null)
  const [ticketReport, setTicketReport] = useState<TicketReport | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null)
  const [compliance, setCompliance] = useState<ComplianceReport | null>(null)
  const [workerTimeSeries, setWorkerTimeSeries] = useState<AiWorkerTimeSeries[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const range = useMemo(() => dateRange(datePreset, customFrom, customTo), [datePreset, customFrom, customTo])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [ov, tk, an, co] = await Promise.allSettled([
        getOverviewReport(range),
        getTicketReport(),
        getAnalyticsReport(),
        getComplianceReport(),
      ])
      if (ov.status === 'fulfilled') {
        setOverview(ov.value)
        if (ov.value.aiWorkerTimeSeries) setWorkerTimeSeries(ov.value.aiWorkerTimeSeries)
      }
      if (tk.status === 'fulfilled') setTicketReport(tk.value)
      if (an.status === 'fulfilled') setAnalytics(an.value)
      if (co.status === 'fulfilled') setCompliance(co.value)
      if (ov.status === 'rejected') setError(ov.reason instanceof Error ? ov.reason.message : 'Failed to load reports')
    } finally { setLoading(false) }
  }, [range.from, range.to])

  useEffect(() => { loadAll() }, [loadAll])

  /* ─── Export handlers ─── */
  const handleExportOverview = useCallback((format: string) => {
    if (!overview) return
    const title = `ReyDesk Overview Report`
    if (format === 'csv') {
      exportCSV(
        ['Metric', 'Value'],
        [
          ['Total Tickets', overview.totals.total],
          ['Open Tickets', overview.totals.open],
          ['Resolved Tickets', overview.totals.resolved],
          ['SLA Compliance', `${overview.sla.complianceRate}%`],
          ['Avg Resolution Time', formatMinutes(overview.resolution.avg_minutes)],
          ['Avg First Response', formatMinutes(overview.firstResponse.avg_minutes)],
          ['Total Sessions', overview.sessions.total],
          ['Live Sessions', overview.sessions.live],
        ],
        'reydesk-overview',
      )
    } else if (format === 'json') {
      exportJSON(overview, 'reydesk-overview')
    } else if (format === 'html') {
      exportHTML(title, `
        <table><tr><th>Metric</th><th class="num">Value</th></tr>
        <tr><td>Total Tickets</td><td class="num">${overview.totals.total}</td></tr>
        <tr><td>Open</td><td class="num">${overview.totals.open}</td></tr>
        <tr><td>Resolved</td><td class="num">${overview.totals.resolved}</td></tr>
        <tr><td>SLA Compliance</td><td class="num">${overview.sla.complianceRate}%</td></tr>
        <tr><td>Avg Resolution</td><td class="num">${formatMinutes(overview.resolution.avg_minutes)}</td></tr>
        <tr><td>Avg Response</td><td class="num">${formatMinutes(overview.firstResponse.avg_minutes)}</td></tr>
        <tr><td>Total Sessions</td><td class="num">${overview.sessions.total}</td></tr>
        <tr><td>Live Sessions</td><td class="num">${overview.sessions.live}</td></tr>
        </table>`, 'reydesk-overview')
    } else if (format === 'print') {
      printReport(title, `
        <table><tr><th>Metric</th><th class="num">Value</th></tr>
        <tr><td>Total Tickets</td><td class="num">${overview.totals.total}</td></tr>
        <tr><td>Open</td><td class="num">${overview.totals.open}</td></tr>
        <tr><td>Resolved</td><td class="num">${overview.totals.resolved}</td></tr>
        <tr><td>SLA Compliance</td><td class="num">${overview.sla.complianceRate}%</td></tr>
        <tr><td>Avg Resolution</td><td class="num">${formatMinutes(overview.resolution.avg_minutes)}</td></tr>
        <tr><td>Avg Response</td><td class="num">${formatMinutes(overview.firstResponse.avg_minutes)}</td></tr></table>`)
    }
  }, [overview])

  const handleExportTickets = useCallback((format: string) => {
    if (!ticketReport) return
    if (format === 'csv') {
      exportCSV(
        ['Status', 'Count'],
        ticketReport.byStatus.map(s => [STATUS_LABELS[s.status] ?? s.status, s.n]),
        'reydesk-ticket-status',
      )
    } else if (format === 'json') {
      exportJSON(ticketReport, 'reydesk-tickets')
    }
  }, [ticketReport])

  const handleExportAgents = useCallback((format: string) => {
    if (!overview) return
    if (format === 'csv') {
      exportCSV(
        ['Agent', 'Total', 'Open', 'Resolved', 'Avg Resolution', 'Avg Response'],
        overview.byAssignee.map(a => [a.name, a.total, a.open, a.resolved, formatMinutes(a.avg_resolution_min), formatMinutes(a.avg_response_min)]),
        'reydesk-agent-performance',
      )
    } else if (format === 'json') {
      exportJSON(overview.byAssignee, 'reydesk-agents')
    }
  }, [overview])

  /* ─── Helper ─── */
  const TrendFromAvg = (vals: number[]): number | undefined => {
    if (vals.length < 2) return undefined
    const mid = Math.floor(vals.length / 2)
    const first = vals.slice(0, mid).reduce((a, b) => a + b, 0) / mid
    const second = vals.slice(mid).reduce((a, b) => a + b, 0) / (vals.length - mid)
    if (first === 0) return undefined
    return ((second - first) / first) * 100
  }

  return (
    <Shell>
      {/* ─── Header ─── */}
      <div className="rpt-header">
        <div className="rpt-header-left">
          <h1 className="page-title">Reports & Analytics</h1>
          <span className="rpt-header-sub">ReyDesk · {datePreset === 'all' ? 'All time' : datePreset === 'custom' ? `${customFrom || '...'} to ${customTo || '...'}` : `Last ${datePreset.replace('d', ' days').replace('today', '24 hours')}`}</span>
        </div>
        <div className="rpt-header-right">
          <ExportMenu onExport={() => handleExportOverview('csv')} />
        </div>
      </div>

      {/* ─── Date Picker ─── */}
      <div className="rpt-toolbar">
        <div className="rpt-date-presets">
          {(['today', '7d', '30d', '90d', 'all'] as DatePreset[]).map(p => (
            <button key={p} className={`rpt-preset ${datePreset === p ? 'active' : ''}`}
              onClick={() => { setDatePreset(p); }}>
              {p === 'today' ? 'Today' : p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : p === '90d' ? '90 Days' : 'All Time'}
            </button>
          ))}
          <button className={`rpt-preset ${datePreset === 'custom' ? 'active' : ''}`}
            onClick={() => setDatePreset('custom')}>
            Custom
          </button>
          {datePreset === 'custom' && (
            <div className="rpt-custom-dates">
              <input type="date" className="rpt-date-input" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
              <span className="rpt-date-sep">to</span>
              <input type="date" className="rpt-date-input" value={customTo} onChange={e => setCustomTo(e.target.value)} />
            </div>
          )}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={loadAll} disabled={loading}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>

      {/* ─── Tabs ─── */}
      <div className="rpt-tabs">
        {([
          { id: 'overview', label: 'Overview', icon: 'chart' },
          { id: 'tickets', label: 'Tickets', icon: 'ticket' },
          { id: 'agents', label: 'Agents', icon: 'user' },
          { id: 'sessions', label: 'Sessions', icon: 'monitor' },
          { id: 'csat', label: 'Satisfaction', icon: 'star' },
          { id: 'compliance', label: 'Compliance', icon: 'shield' },
          { id: 'ai-workers', label: 'AI Workers', icon: 'activity' },
        ] as { id: Tab; label: string; icon: 'chart' | 'ticket' | 'user' | 'monitor' | 'star' | 'shield' }[]).map(t => (
          <button key={t.id} className={`rpt-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="rpt-tab-icon"><Icon name={t.icon} size={14} /></span> {t.label}
          </button>
        ))}
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {loading && !overview && <div className="rpt-loading">Loading report data…</div>}

      {/* ═══════════════════════════════════════════════════════════
         OVERVIEW TAB
         ═══════════════════════════════════════════════════════════ */}
      {overview && tab === 'overview' && (
        <div className="rpt-sections">
          {/* KPI Row */}
          <div className="rpt-kpi-row">
            <StatCard label="Total Tickets" value={overview.totals.total}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/></svg>} />
            <StatCard label="Open" value={overview.totals.open} tone="warn"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>}
              sub={`${overview.totals.new_count} new · ${overview.totals.escalated} escalated`} />
            <StatCard label="Resolved" value={overview.totals.resolved} tone="ok"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>} />
            <StatCard label="SLA Compliance" value={`${overview.sla.complianceRate}%`}
              tone={overview.sla.complianceRate >= 90 ? 'ok' : overview.sla.complianceRate >= 70 ? 'warn' : 'crit'}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>}
              sub={`${overview.sla.response_breached} response · ${overview.sla.resolution_breached} resolution breaches`} />
            <StatCard label="Avg Response" value={formatMinutes(overview.firstResponse.avg_minutes)}
              sub={`Median ${formatMinutes(overview.firstResponse.median_minutes)}`}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>} />
            <StatCard label="Avg Resolution" value={formatMinutes(overview.resolution.avg_minutes)}
              sub={`Median ${formatMinutes(overview.resolution.median_minutes)} · P95 ${formatMinutes(overview.resolution.p95_minutes)}`}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
          </div>

          {/* Trend line */}
          <div className="rpt-charts-row">
            <div className="rpt-chart-card rpt-wide">
              <h3 className="rpt-card-title">Ticket Volume (90 days)</h3>
              <LineChart data={overview.daily.map(d => ({ label: d.day, value: d.n }))} color="var(--accent)" />
            </div>
          </div>

          {/* Charts grid */}
          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Status</h3>
              <DonutChart
                segments={overview.byStatus.map(s => ({
                  value: s.n, color: STATUS_COLORS[s.status] ?? '#6b7280', label: STATUS_LABELS[s.status] ?? s.status,
                }))}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Priority</h3>
              <DonutChart
                segments={overview.byPriority.map(p => ({
                  value: p.n, color: PRIORITY_COLORS[p.priority] ?? '#6b7280', label: PRIORITY_LABELS[p.priority] ?? p.priority,
                }))}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Source</h3>
              <DonutChart
                segments={overview.bySource.map((s, i) => ({
                  value: s.n, color: COLORS[i % COLORS.length], label: s.source,
                }))}
              />
            </div>
          </div>

          {/* Hourly heatmap */}
          <div className="rpt-charts-row">
            <div className="rpt-chart-card rpt-wide">
              <HeatmapChart data={overview.hourly.map(h => ({ hour: h.hour, n: h.n }))} label="Hourly Distribution (All Time)" />
            </div>
          </div>

          {/* Bar charts */}
          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Category</h3>
              <BarChart data={overview.byCategory.map((c, i) => ({ label: c.category, value: c.n, color: COLORS[i % COLORS.length] }))} />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Team</h3>
              <BarChart data={overview.byTeam.map((t, i) => ({ label: t.team, value: t.n, color: COLORS[(i + 3) % COLORS.length] }))} />
            </div>
          </div>

          {/* Summary grid */}
          <div className="rpt-summary-grid">
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Sessions</span>
              <span className="rpt-summary-value">{overview.sessions.total}</span>
              <span className="rpt-summary-sub">{overview.sessions.live} live · {formatMinutes(overview.sessions.avg_duration_min)} avg</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Audit Events</span>
              <span className="rpt-summary-value">{overview.auditTotal.toLocaleString()}</span>
              <span className="rpt-summary-sub">Full audit trail</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">SLA Breaches</span>
              <span className="rpt-summary-value rpt-crit">{overview.totals.breached}</span>
              <span className="rpt-summary-sub">{overview.totals.total ? ((overview.totals.breached / overview.totals.total) * 100).toFixed(1) : 0}% breach rate</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Active Agents</span>
              <span className="rpt-summary-value">{overview.byAssignee.length}</span>
              <span className="rpt-summary-sub">{overview.byAssignee.filter(a => a.open > 0).length} with open tickets</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         TICKETS TAB
         ═══════════════════════════════════════════════════════════ */}
      {ticketReport && tab === 'tickets' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">Ticket Analytics</h2>
            <ExportMenu onExport={handleExportTickets} />
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Total Tickets" value={ticketReport.totals.total} />
            <StatCard label="Open" value={ticketReport.totals.open} tone="warn" />
            <StatCard label="Resolved" value={ticketReport.totals.resolved} tone="ok" />
            <StatCard label="SLA Breaches" value={ticketReport.totals.breached} tone="crit" />
            <StatCard label="Avg Response" value={formatMinutes(ticketReport.firstResponse.avg_minutes)} />
            <StatCard label="Avg Resolution" value={formatMinutes(ticketReport.resolution.avg_minutes)} />
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card rpt-wide">
              <h3 className="rpt-card-title">Daily Ticket Creation (14 days)</h3>
              <LineChart data={ticketReport.createdDaily.map(d => ({ label: d.day, value: d.n }))} color="#3b82f6" />
            </div>
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Status Distribution</h3>
              <DonutChart
                segments={ticketReport.byStatus.map(s => ({
                  value: s.n, color: STATUS_COLORS[s.status] ?? '#6b7280', label: STATUS_LABELS[s.status] ?? s.status,
                }))}
                size={200}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Priority Breakdown</h3>
              <DonutChart
                segments={ticketReport.byPriority.map(p => ({
                  value: p.n, color: PRIORITY_COLORS[p.priority] ?? '#6b7280', label: PRIORITY_LABELS[p.priority] ?? p.priority,
                }))}
                size={200}
              />
            </div>
          </div>

          {/* Ticket data table */}
          <div className="rpt-chart-card rpt-wide">
            <h3 className="rpt-card-title">Assignee Breakdown</h3>
            <div className="rpt-table-wrap">
              <table className="rpt-table">
                <thead>
                  <tr><th>Agent</th><th className="num">Open</th><th className="num">Total</th></tr>
                </thead>
                <tbody>
                  {ticketReport.byAssignee.map(a => (
                    <tr key={a.id}><td>{a.name}</td><td className="num">{a.open_tickets}</td><td className="num">{a.open_tickets}</td></tr>
                  ))}
                  {ticketReport.byAssignee.length === 0 && <tr><td colSpan={3} className="rpt-empty">No assignees</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         AGENTS TAB
         ═══════════════════════════════════════════════════════════ */}
      {overview && tab === 'agents' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">Agent Performance</h2>
            <ExportMenu onExport={handleExportAgents} />
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Active Agents" value={overview.byAssignee.length}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>} />
            <StatCard label="Avg Resolution" value={formatMinutes(overview.resolution.avg_minutes)} tone="ok" />
            <StatCard label="Avg Response" value={formatMinutes(overview.firstResponse.avg_minutes)} />
          </div>

          <div className="rpt-chart-card rpt-wide">
            <h3 className="rpt-card-title">Agent Performance Table</h3>
            <div className="rpt-table-wrap">
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th>Agent</th><th className="num">Total</th><th className="num">Open</th>
                    <th className="num">Resolved</th><th className="num">Avg Resolution</th><th className="num">Avg Response</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.byAssignee.map(a => (
                    <tr key={a.id}>
                      <td className="rpt-agent-name">{a.name}</td>
                      <td className="num">{a.total}</td>
                      <td className="num">{a.open}</td>
                      <td className="num" style={{ color: 'var(--ok)' }}>{a.resolved}</td>
                      <td className="num">{formatMinutes(a.avg_resolution_min)}</td>
                      <td className="num">{formatMinutes(a.avg_response_min)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Agent workload bar chart */}
          <div className="rpt-chart-card rpt-wide">
            <h3 className="rpt-card-title">Workload Distribution</h3>
            <BarChart
              data={overview.byAssignee.slice(0, 10).map(a => ({
                label: a.name, value: a.open, sub: 'open', color: 'var(--accent)',
              }))}
            />
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         SESSIONS TAB
         ═══════════════════════════════════════════════════════════ */}
      {analytics && tab === 'sessions' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">Remote Sessions</h2>
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Total Sessions" value={analytics.sessions.total}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>} />
            <StatCard label="Live Now" value={analytics.sessions.live} tone={analytics.sessions.live > 0 ? 'ok' : 'default'} />
            <StatCard label="Avg Duration" value={formatMinutes(analytics.sessions.avg_duration_min)} />
            <StatCard label="SLA Compliance" value={`${analytics.sla.complianceRate}%`}
              tone={analytics.sla.complianceRate >= 90 ? 'ok' : 'crit'} />
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card rpt-wide">
              <h3 className="rpt-card-title">Sessions (30 days)</h3>
              <LineChart data={analytics.sessions.perDay.map(d => ({ label: d.day, value: d.n }))} color="#8b5cf6" />
            </div>
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Type</h3>
              <DonutChart
                segments={analytics.sessions.byType.map((t, i) => ({
                  value: t.n, color: COLORS[i % COLORS.length], label: t.type,
                }))}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By State</h3>
              <BarChart
                data={analytics.sessions.byState.map((s, i) => ({
                  label: s.state, value: s.n, color: COLORS[i % COLORS.length],
                }))}
              />
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         SATISFACTION (CSAT) TAB
         ═══════════════════════════════════════════════════════════ */}
      {analytics && tab === 'csat' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">Customer Satisfaction</h2>
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Average Rating" value={analytics.csat.average ? `${analytics.csat.average}/5` : '—'}
              tone={analytics.csat.average >= 4.5 ? 'ok' : analytics.csat.average >= 3.5 ? 'warn' : analytics.csat.average > 0 ? 'crit' : 'default'} />
            <StatCard label="Satisfaction Rate" value={analytics.csat.rated ? `${analytics.csat.satisfactionRate}%` : '—'}
              tone={analytics.csat.satisfactionRate >= 80 ? 'ok' : analytics.csat.satisfactionRate >= 60 ? 'warn' : 'crit'} />
            <StatCard label="Ratings Received" value={analytics.csat.rated} />
            <StatCard label="Response Rate" value={`${analytics.csat.responseRate}%`} />
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Rating Distribution</h3>
              <BarChart
                data={analytics.csat.byRating.map((r) => ({
                  label: `${r.rating}★`, value: r.n, color: r.rating >= 4 ? '#2ca66f' : r.rating === 3 ? '#e8a33d' : '#e5484d',
                }))}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">By Technician</h3>
              {analytics.csat.perTechnician.length === 0 ? (
                <p className="rpt-empty">No ratings yet. Scores appear once requesters rate resolved tickets.</p>
              ) : (
                <div className="rpt-csat-techs">
                  {analytics.csat.perTechnician.map((tech) => (
                    <div className="rpt-csat-tech" key={tech.id}>
                      <span className="rpt-csat-tech-name">{tech.name}</span>
                      <span className="rpt-csat-tech-star">{'★'.repeat(Math.round(tech.average))}{tech.average < 5 ? '☆'.repeat(5 - Math.round(tech.average)) : ''}</span>
                      <span className="rpt-csat-tech-meta mono">{tech.rated} rated · {tech.average.toFixed(1)}/5</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         COMPLIANCE TAB
         ═══════════════════════════════════════════════════════════ */}
      {compliance && tab === 'compliance' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">Compliance & Security</h2>
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Audit Integrity" value={compliance.audit.integrityOk ? 'Intact' : 'Broken'}
              tone={compliance.audit.integrityOk ? 'ok' : 'crit'}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>} />
            <StatCard label="Audit Events" value={compliance.audit.total.toLocaleString()} sub={`${compliance.audit.last24h} in last 24h`} />
            <StatCard label="JIT Access Grants" value={compliance.jit.total} sub={`${compliance.jit.active} active`} />
            <StatCard label="Recordings" value={compliance.recordings.sessions} sub={`${compliance.recordings.video} video`} />
          </div>

          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">JIT Access Grants</h3>
              <DonutChart
                segments={[
                  { value: compliance.jit.active, color: '#10b981', label: 'Active' },
                  { value: compliance.jit.approved, color: '#3b82f6', label: 'Approved' },
                  { value: compliance.jit.revoked, color: '#ef4444', label: 'Revoked' },
                ]}
                size={160}
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Session Recordings</h3>
              <DonutChart
                segments={[
                  { value: compliance.recordings.video, color: '#8b5cf6', label: 'Video' },
                  { value: compliance.recordings.metadata, color: '#06b6d4', label: 'Metadata' },
                ]}
                size={160}
              />
            </div>
          </div>

          <div className="rpt-summary-grid">
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Audit Chain</span>
              <span className={`rpt-summary-value ${compliance.audit.integrityOk ? 'rpt-ok' : 'rpt-crit'}`}>
                {compliance.audit.integrityOk ? '✓ Verified' : '✗ Broken'}
              </span>
              <span className="rpt-summary-sub">Hash-chain integrity check</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">SLA Compliance</span>
              <span className="rpt-summary-value">{analytics?.sla.complianceRate ?? '—'}%</span>
              <span className="rpt-summary-sub">{compliance.jit.total} privileged access grants</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Video Recordings</span>
              <span className="rpt-summary-value">{compliance.recordings.video}</span>
              <span className="rpt-summary-sub">{compliance.recordings.sessions} total sessions recorded</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
         AI WORKERS TAB
         ═══════════════════════════════════════════════════════════ */}
      {overview && tab === 'ai-workers' && (
        <div className="rpt-sections">
          <div className="rpt-section-head">
            <h2 className="rpt-section-title">AI Worker Performance</h2>
          </div>

          <div className="rpt-kpi-row">
            <StatCard label="Total Runs" value={overview.aiWorkers.total}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/></svg>} />
            <StatCard label="Resolved" value={overview.aiWorkers.resolved} tone="ok"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>} />
            <StatCard label="Handed Off" value={overview.aiWorkers.escalated} tone="warn"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>} />
            <StatCard label="Resolution Rate" value={`${overview.aiWorkers.resolutionRate}%`}
              tone={overview.aiWorkers.resolutionRate >= 70 ? 'ok' : overview.aiWorkers.resolutionRate >= 40 ? 'warn' : 'crit'}
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>} />
            <StatCard label="Time Saved" value={formatMinutes(overview.aiWorkers.timeSavedMinutes)}
              sub="vs estimated manual time"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
            <StatCard label="Avg Actual Time" value={formatMinutes(overview.aiWorkers.avgActualMinutes)}
              sub="per resolved run"
              icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>} />
          </div>

          {/* Time-series chart */}
          {workerTimeSeries.length > 0 && (
            <div className="rpt-charts-row">
              <div className="rpt-chart-card rpt-wide">
                <h3 className="rpt-card-title">Worker Runs (30 days)</h3>
                <LineChart data={workerTimeSeries.map(d => ({ label: d.day, value: d.total }))} color="#8b5cf6" label="Daily Runs" />
                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem', fontSize: '12px', color: 'var(--text-2)' }}>
                  <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#10b981', marginRight: 4 }} />Resolved</span>
                  <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#f59e0b', marginRight: 4 }} />Handed Off</span>
                  <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: '#ef4444', marginRight: 4 }} />Failed</span>
                </div>
              </div>
            </div>
          )}

          <div className="rpt-charts-row">
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Outcome Distribution</h3>
              <DonutChart
                segments={[
                  { value: overview.aiWorkers.resolved, color: '#10b981', label: 'Resolved' },
                  { value: overview.aiWorkers.escalated, color: '#f59e0b', label: 'Handed Off' },
                  { value: Math.max(0, overview.aiWorkers.total - overview.aiWorkers.resolved - overview.aiWorkers.escalated), color: '#ef4444', label: 'Failed / Cancelled' },
                ]}
                size={180}
                label="Worker Outcomes"
              />
            </div>
            <div className="rpt-chart-card">
              <h3 className="rpt-card-title">Agent Update Health</h3>
              {overview.updateHealth ? (
                <BarChart
                  data={[
                    { label: 'Health Checks', value: overview.updateHealth.healthChecks, color: '#3b82f6' },
                    { label: 'Updates Offered', value: overview.updateHealth.offersChecked, color: '#8b5cf6' },
                    { label: 'Successful', value: overview.updateHealth.successfulUpdates, color: '#10b981' },
                    { label: 'Failed', value: overview.updateHealth.failedUpdates, color: '#ef4444' },
                  ]}
                  horizontal
                />
              ) : (
                <div className="rpt-empty">No update data</div>
              )}
            </div>
          </div>

          <div className="rpt-summary-grid">
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Total AI Runs</span>
              <span className="rpt-summary-value">{overview.aiWorkers.total}</span>
              <span className="rpt-summary-sub">Across all tickets</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Resolution Rate</span>
              <span className={`rpt-summary-value ${overview.aiWorkers.resolutionRate >= 70 ? 'rpt-ok' : 'rpt-crit'}`}>{overview.aiWorkers.resolutionRate}%</span>
              <span className="rpt-summary-sub">Auto-resolved vs total</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Time Saved</span>
              <span className="rpt-summary-value rpt-ok">{formatMinutes(overview.aiWorkers.timeSavedMinutes)}</span>
              <span className="rpt-summary-sub">Estimated manual effort avoided</span>
            </div>
            <div className="rpt-summary-card">
              <span className="rpt-summary-label">Last Agent Check</span>
              <span className="rpt-summary-value">{overview.updateHealth?.lastCheck ? new Date(overview.updateHealth.lastCheck).toLocaleDateString() : '—'}</span>
              <span className="rpt-summary-sub">Device agent update verification</span>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay */}
      {loading && overview && (
        <div className="rpt-refresh-overlay">
          <div className="rpt-spinner" />
        </div>
      )}
    </Shell>
  )
}
