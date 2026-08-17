import { useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { STATUS_LABELS } from '../lib/tickets.js'
import { formatMinutes, getTicketReport, type TicketReport } from '../lib/reports.js'
import { getAnalyticsReport, type AnalyticsReport } from '../lib/audit.js'

const PRIORITY_ORDER = ['p1', 'p2', 'p3', 'p4']

export default function ReportsPage() {
  const [report, setReport] = useState<TicketReport | null>(null)
  const [analytics, setAnalytics] = useState<AnalyticsReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getTicketReport()
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load report'))
    getAnalyticsReport()
      .then(setAnalytics)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load analytics'))
  }, [])

  const maxStatusCount = report ? Math.max(1, ...report.byStatus.map((s) => s.n)) : 1
  const maxDaily = report ? Math.max(1, ...report.createdDaily.map((d) => d.n)) : 1

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Reports</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {!report && !error ? <div className="etch" style={{ padding: 24 }}>Crunching numbers…</div> : null}

      {report ? (
        <>
          <div className="stat-row">
            <StatCard label="Total tickets" value={report.totals.total} />
            <StatCard label="Open" value={report.totals.open} />
            <StatCard label="Resolved" value={report.totals.resolved} tone="ok" />
            <StatCard label="SLA breached" value={report.totals.breached} tone={report.totals.breached ? 'crit' : 'muted'} />
          </div>

          <div className="report-grid">
            <section className="reportCard">
              <h2 className="reportCard-title">Avg response</h2>
              <p className="reportCard-value mono">{formatMinutes(report.firstResponse.avg_minutes)}</p>
              <p className="reportCard-sub muted">across {report.firstResponse.n} first responses</p>
            </section>
            <section className="reportCard">
              <h2 className="reportCard-title">Avg resolution</h2>
              <p className="reportCard-value mono">{formatMinutes(report.resolution.avg_minutes)}</p>
              <p className="reportCard-sub muted">across {report.resolution.n} resolved tickets</p>
            </section>
          </div>

          <section className="reportCard" style={{ marginBottom: 16 }}>
            <h2 className="reportCard-title">By status</h2>
            <div className="bar-list">
              {report.byStatus.map((s) => (
                <div key={s.status} className="bar-row">
                  <span className="bar-label">{STATUS_LABELS[s.status] ?? s.status}</span>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(s.n / maxStatusCount) * 100}%` }} />
                  </div>
                  <span className="bar-value mono">{s.n}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="reportCard" style={{ marginBottom: 16 }}>
            <h2 className="reportCard-title">By priority</h2>
            <div className="bar-list">
              {PRIORITY_ORDER.map((p) => {
                const row = report.byPriority.find((r) => r.priority === p)
                const n = row?.n ?? 0
                return (
                  <div key={p} className="bar-row">
                    <span className="bar-label mono">{p.toUpperCase()}</span>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${(n / maxStatusCount) * 100}%` }} /></div>
                    <span className="bar-value mono">{n}</span>
                  </div>
                )
              })}
            </div>
          </section>

          <section className="reportCard">
            <h2 className="reportCard-title">Tickets created (last 14 days)</h2>
            <div className="sparkline">
              {report.createdDaily.map((d) => (
                <div key={d.day} className="spark-bar" title={`${d.day}: ${d.n}`}>
                  <div className="spark-bar-fill" style={{ height: `${(d.n / maxDaily) * 100}%` }} />
                </div>
              ))}
            </div>
            <div className="reportCard-sub muted">
              {report.byAssignee.length > 0 ? (
                <>
                  Busiest queue: {report.byAssignee[0].name} — {report.byAssignee[0].open_tickets} open
                </>
              ) : 'No active assignments.'}
            </div>
          </section>

          {analytics ? (
            <>
              <h2 className="reportCard-title" style={{ marginTop: 24 }}>Remote sessions</h2>
              <div className="stat-row">
                <StatCard label="Total sessions" value={analytics.sessions.total} />
                <StatCard label="Live" value={analytics.sessions.live} />
                <StatCard label="Avg duration" value={analytics.sessions.avg_duration_min} />
                <StatCard label="SLA compliance %" value={analytics.sla.complianceRate} tone={analytics.sla.complianceRate < 90 ? 'crit' : 'ok'} />
              </div>
              <section className="reportCard" style={{ marginBottom: 16 }}>
                <h2 className="reportCard-title">Sessions by type</h2>
                <div className="bar-list">
                  {analytics.sessions.byType.map((s) => (
                    <div key={s.type} className="bar-row">
                      <span className="bar-label mono">{s.type}</span>
                      <div className="bar-track"><div className="bar-fill" style={{ width: `${(s.n / Math.max(1, analytics.sessions.total)) * 100}%` }} /></div>
                      <span className="bar-value mono">{s.n}</span>
                    </div>
                  ))}
                </div>
              </section>
              {analytics.workload.length > 0 ? (
                <section className="reportCard">
                  <h2 className="reportCard-title">Technician workload</h2>
                  <div className="queue-table">
                    <table>
                      <thead>
                        <tr><th>Technician</th><th>Open</th><th>Resolved</th><th>Avg resolution</th></tr>
                      </thead>
                      <tbody>
                        {analytics.workload.map((w) => (
                          <tr key={w.id}>
                            <td>{w.name}</td>
                            <td className="mono">{w.open}</td>
                            <td className="mono">{w.resolved}</td>
                            <td className="mono">{formatMinutes(w.avg_resolution_min)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Shell>
  )
}

function StatCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'ok' | 'crit' | 'muted' }) {
  return (
    <div className="stat-card">
      <span className={`stat-value mono${tone === 'crit' ? ' sla-crit' : tone === 'ok' ? ' sla-ok' : ''}`}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  )
}