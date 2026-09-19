import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import {
  getGovernanceSummary, getGovernanceActivity,
  getToolPermissions, updateToolPermission,
  getCostSummary,
  listUsageAlerts, createUsageAlert, deleteUsageAlert,
  type ActivityLogEntry, type ActivitySummary, type ToolPermission, type CostSummary, type UsageAlert,
} from '../lib/governance.js'
import { useAuth } from '../lib/auth.js'

function formatNum(n: number): string { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n) }
function formatCost(n: number): string { return `$${n < 0.01 ? '<0.01' : n.toFixed(2)}` }

const ALERT_TYPES = [
  { value: 'request_threshold', label: 'Request count' },
  { value: 'token_threshold', label: 'Token usage' },
  { value: 'cost_threshold', label: 'Cost ($)' },
  { value: 'failure_rate', label: 'Failure rate (%)' },
]

export default function AiGovernancePage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap(m => m.permissions))
  const canManage = perms.has('ai_agent.manage')
  const canRead = perms.has('ai_agent.read')

  const [days, setDays] = useState(30)
  const [summary, setSummary] = useState<ActivitySummary | null>(null)
  const [activity, setActivity] = useState<ActivityLogEntry[]>([])
  const [tools, setTools] = useState<ToolPermission[]>([])
  const [costs, setCosts] = useState<CostSummary | null>(null)
  const [alerts, setAlerts] = useState<UsageAlert[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Activity filters
  const [actFilter, setActFilter] = useState('')
  const [actActor, setActActor] = useState('')
  const [actTool, setActTool] = useState('')

  // Alert creation
  const [alertType, setAlertType] = useState('request_threshold')
  const [alertThreshold, setAlertThreshold] = useState('')
  const [alertBusy, setAlertBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [s, a, t, c, al] = await Promise.allSettled([
        getGovernanceSummary(days),
        getGovernanceActivity({ days, limit: 50, action: actFilter || undefined, actor_type: actActor || undefined, tool_name: actTool || undefined }),
        getToolPermissions(),
        getCostSummary(days),
        listUsageAlerts(),
      ])
      if (s.status === 'fulfilled') setSummary(s.value.summary)
      if (a.status === 'fulfilled') setActivity(a.value.entries)
      if (t.status === 'fulfilled') setTools(t.value.permissions)
      if (c.status === 'fulfilled') setCosts(c.value.costs)
      if (al.status === 'fulfilled') setAlerts(al.value.alerts)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load governance data')
    }
    setLoading(false)
  }, [days, actFilter, actActor, actTool])

  useEffect(() => { void load() }, [load])

  const toggleTool = async (tool: ToolPermission) => {
    if (!canManage) return
    try {
      await updateToolPermission(tool.tool_name, { enabled: !tool.enabled })
      setTools(prev => prev.map(t => t.tool_name === tool.tool_name ? { ...t, enabled: !t.enabled } : t))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tool')
    }
  }

  const toggleApproval = async (tool: ToolPermission) => {
    if (!canManage) return
    try {
      await updateToolPermission(tool.tool_name, { requires_approval: !tool.requires_approval })
      setTools(prev => prev.map(t => t.tool_name === tool.tool_name ? { ...t, requires_approval: !t.requires_approval } : t))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update tool'  )
    }
  }

  const addAlert = async () => {
    if (!alertThreshold.trim() || alertBusy) return
    setAlertBusy(true)
    try {
      await createUsageAlert(alertType, Number(alertThreshold))
      setAlertThreshold('')
      const { alerts: al } = await listUsageAlerts()
      setAlerts(al)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert')
    }
    setAlertBusy(false)
  }

  const removeAlert = async (id: string) => {
    try {
      await deleteUsageAlert(id)
      setAlerts(prev => prev.filter(a => a.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete alert')
    }
  }

  const successRate = summary && summary.totalActions > 0
    ? Math.round((summary.successfulActions / summary.totalActions) * 100)
    : 0

  return (
    <Shell>
      <div className="rpt-header">
        <div className="rpt-header-left">
          <h1 className="page-title">AI Governance</h1>
          <p className="rpt-header-sub">Monitor all AI activity, control tool permissions, track costs, and manage usage alerts.</p>
        </div>
        <div className="rpt-header-right">
          <select className="rpt-date-input" value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {loading && <p style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading governance data...</p>}

      {!loading && summary && (
        <div className="rpt-sections">
          {/* ── KPI Row ───────────────────────────────────────── */}
          <div className="rpt-kpi-row">
            <div className="rpt-stat rpt-stat-info">
              <div className="rpt-stat-head"><span className="rpt-stat-icon"><Icon name="activity" size={16} /></span><span className="rpt-stat-label">Total Actions</span></div>
              <div className="rpt-stat-body"><span className="rpt-stat-value">{formatNum(summary.totalActions)}</span><span className="rpt-stat-sub">in {days}d</span></div>
            </div>
            <div className={`rpt-stat ${successRate >= 90 ? 'rpt-stat-ok' : successRate >= 70 ? 'rpt-stat-warn' : 'rpt-stat-crit'}`}>
              <div className="rpt-stat-head"><span className="rpt-stat-icon"><Icon name="check" size={16} /></span><span className="rpt-stat-label">Success Rate</span></div>
              <div className="rpt-stat-body"><span className="rpt-stat-value">{successRate}%</span><span className="rpt-stat-sub">{summary.failedActions} failures</span></div>
            </div>
            <div className="rpt-stat">
              <div className="rpt-stat-head"><span className="rpt-stat-icon"><Icon name="sparkles" size={16} /></span><span className="rpt-stat-label">Token Usage</span></div>
              <div className="rpt-stat-body"><span className="rpt-stat-value">{formatNum(summary.tokenUsage.input + summary.tokenUsage.output)}</span><span className="rpt-stat-sub">{formatNum(summary.tokenUsage.input)} in / {formatNum(summary.tokenUsage.output)} out</span></div>
            </div>
            {costs && (
              <>
                <div className="rpt-stat">
                  <div className="rpt-stat-head"><span className="rpt-stat-icon"><Icon name="chart" size={16} /></span><span className="rpt-stat-label">Total Cost</span></div>
                  <div className="rpt-stat-body"><span className="rpt-stat-value">{formatCost(costs.totalCostUsd)}</span><span className="rpt-stat-sub">{costs.totalRuns} runs</span></div>
                </div>
                <div className="rpt-stat">
                  <div className="rpt-stat-head"><span className="rpt-stat-icon"><Icon name="chart" size={16} /></span><span className="rpt-stat-label">Avg Cost/Run</span></div>
                  <div className="rpt-stat-body"><span className="rpt-stat-value">{formatCost(costs.avgCostPerRun)}</span><span className="rpt-stat-sub">{formatNum(costs.totalInputTokens)} in / {formatNum(costs.totalOutputTokens)} out</span></div>
                </div>
              </>
            )}
          </div>

          {/* ── Cost Over Time ─────────────────────────────────── */}
          {costs && costs.costByDay.length > 0 && (
            <div className="rpt-charts-row">
              <div className="rpt-chart-card rpt-wide">
                <h3 className="rpt-card-title">Cost Over Time</h3>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
                  {costs.costByDay.map(d => {
                    const maxCost = Math.max(...costs.costByDay.map(x => x.cost), 0.01)
                    const h = Math.max(2, (d.cost / maxCost) * 110)
                    return (
                      <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                        <span style={{ fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{formatCost(d.cost)}</span>
                        <div style={{ width: '100%', height: h, background: 'var(--accent)', borderRadius: 3, opacity: 0.8, transition: 'height 0.3s' }} title={`${d.day}: ${formatCost(d.cost)} (${d.runs} runs)`} />
                        <span style={{ fontSize: 8, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{d.day.slice(5)}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* ── Tool Usage + Actor Breakdown ──────────────────── */}
          <div className="rpt-charts-row">
            {summary.toolUsage.length > 0 && (
              <div className="rpt-chart-card">
                <h3 className="rpt-card-title">Tool Usage</h3>
                <div className="rpt-hbar">
                  {summary.toolUsage.slice(0, 8).map(t => (
                    <div className="rpt-hbar-row" key={t.tool}>
                      <span className="rpt-hbar-label" title={t.tool}>{t.tool}</span>
                      <div className="rpt-hbar-track">
                        <div className="rpt-hbar-fill" style={{ width: `${Math.max(5, (t.count / summary.toolUsage[0].count) * 100)}%`, background: t.success_rate >= 90 ? 'var(--ok)' : t.success_rate >= 70 ? 'var(--warn)' : 'var(--crit)' }} />
                      </div>
                      <span className="rpt-hbar-value">{t.count}</span>
                      <span className="rpt-hbar-sub" style={{ minWidth: 40 }}>{t.success_rate}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {summary.actorBreakdown.length > 0 && (
              <div className="rpt-chart-card">
                <h3 className="rpt-card-title">Actor Breakdown</h3>
                <div className="rpt-hbar">
                  {summary.actorBreakdown.map(a => (
                    <div className="rpt-hbar-row" key={a.actor_type}>
                      <span className="rpt-hbar-label">{a.actor_type}</span>
                      <div className="rpt-hbar-track">
                        <div className="rpt-hbar-fill" style={{ width: `${Math.max(5, (a.count / summary.totalActions) * 100)}%`, background: 'var(--accent)' }} />
                      </div>
                      <span className="rpt-hbar-value">{a.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Tool Permissions ───────────────────────────────── */}
          <div>
            <h3 className="rpt-section-title" style={{ marginBottom: 12 }}>Tool Permissions</h3>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: -8, marginBottom: 12 }}>Control which AI tools are available and whether they require human approval before execution.</p>
            <div className="rpt-table-wrap" style={{ background: 'var(--bg-1)' }}>
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>Enabled</th>
                    <th>Requires Approval</th>
                    <th>Rate Limit /hr</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.map(t => (
                    <tr key={t.tool_name}>
                      <td style={{ fontWeight: 500, fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.tool_name}</td>
                      <td>
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => void toggleTool(t)}
                            className={`ts-badge ts-badge-btn ${t.enabled ? 'ts-badge-ok' : 'ts-badge-muted'}`}
                            style={{ minWidth: 50, textAlign: 'center' }}
                          >
                            {t.enabled ? 'On' : 'Off'}
                          </button>
                        ) : (
                          <span className={`ts-badge ${t.enabled ? 'ts-badge-ok' : 'ts-badge-muted'}`}>{t.enabled ? 'On' : 'Off'}</span>
                        )}
                      </td>
                      <td>
                        {canManage ? (
                          <button
                            type="button"
                            onClick={() => void toggleApproval(t)}
                            className={`ts-badge ts-badge-btn ${t.requires_approval ? 'ts-badge-accent' : 'ts-badge-muted'}`}
                            style={{ minWidth: 50, textAlign: 'center' }}
                          >
                            {t.requires_approval ? 'Yes' : 'No'}
                          </button>
                        ) : (
                          <span className={`ts-badge ${t.requires_approval ? 'ts-badge-accent' : 'ts-badge-muted'}`}>{t.requires_approval ? 'Yes' : 'No'}</span>
                        )}
                      </td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.max_uses_per_hour}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Activity Log ───────────────────────────────────── */}
          <div>
            <div className="rpt-section-head">
              <h3 className="rpt-section-title">Activity Log</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select className="rpt-date-input" value={actFilter} onChange={e => setActFilter(e.target.value)}>
                  <option value="">All actions</option>
                  <option value="triage">Triage</option>
                  <option value="worker_run">Worker run</option>
                  <option value="worker_step">Worker step</option>
                  <option value="tool_call">Tool call</option>
                </select>
                <select className="rpt-date-input" value={actActor} onChange={e => setActActor(e.target.value)}>
                  <option value="">All actors</option>
                  <option value="ai_worker">AI Worker</option>
                  <option value="ai_triage">AI Triage</option>
                  <option value="user">User</option>
                </select>
              </div>
            </div>
            <div className="rpt-table-wrap" style={{ background: 'var(--bg-1)', maxHeight: 400, overflow: 'auto' }}>
              <table className="rpt-table">
                <thead>
                  <tr>
                    <th style={{ width: 160 }}>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Tool</th>
                    <th>Resource</th>
                    <th>Tokens</th>
                    <th>Duration</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.length === 0 && (
                    <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 24 }}>No activity recorded yet. AI actions appear here once an agent or worker runs.</td></tr>
                  )}
                  {activity.map(e => (
                    <tr key={e.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'nowrap' }}>{new Date(e.created_at).toLocaleString()}</td>
                      <td style={{ fontSize: 12 }}>{e.actor_type}</td>
                      <td style={{ fontSize: 12 }}>{e.action}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.tool_name ?? '—'}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{e.resource_type ? `${e.resource_type}${e.resource_id ? `/${e.resource_id.slice(0, 8)}` : ''}` : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.input_tokens + e.output_tokens > 0 ? `${e.input_tokens}↓ ${e.output_tokens}↑` : '—'}</td>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{e.duration_ms > 0 ? `${e.duration_ms}ms` : '—'}</td>
                      <td>
                        <span className={`ts-badge ${e.success ? 'ts-badge-ok' : 'ts-badge-muted'}`} style={{ background: e.success ? undefined : 'rgba(239,68,68,0.12)', color: e.success ? undefined : '#ef4444' }}>
                          {e.success ? 'OK' : 'FAIL'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Usage Alerts ───────────────────────────────────── */}
          <div>
            <h3 className="rpt-section-title" style={{ marginBottom: 12 }}>Usage Alerts</h3>
            <p style={{ color: 'var(--text-3)', fontSize: 12, marginTop: -8, marginBottom: 12 }}>Get notified when AI usage approaches configured thresholds.</p>
            <div className="rpt-charts-row">
              <div className="rpt-chart-card">
                <h3 className="rpt-card-title">Active Alerts</h3>
                {alerts.length === 0 && <p style={{ color: 'var(--text-3)', fontSize: 12, margin: '8px 0' }}>No alerts configured. Add one below.</p>}
                {alerts.map(a => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid var(--line-1)' }}>
                    <div>
                      <span className="ts-badge" style={{ marginRight: 8 }}>{ALERT_TYPES.find(t => t.value === a.alert_type)?.label ?? a.alert_type}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>Threshold: {a.threshold_value}</span>
                      {a.notified && <span className="ts-badge ts-badge-accent" style={{ marginLeft: 8 }}>Fired</span>}
                    </div>
                    {canManage && (
                      <button type="button" className="ts-badge ts-badge-btn ts-badge-muted" onClick={() => void removeAlert(a.id)} title="Remove alert">
                        <Icon name="delete" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {canManage && (
                <div className="rpt-chart-card">
                  <h3 className="rpt-card-title">Add Alert</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                    <select className="field-input" value={alertType} onChange={e => setAlertType(e.target.value)}>
                      {ALERT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <input className="field-input" type="number" min={0} step="any" placeholder="Threshold value" value={alertThreshold} onChange={e => setAlertThreshold(e.target.value)} />
                    <button className="btn btn-primary btn-sm" disabled={alertBusy || !alertThreshold.trim()} onClick={() => void addAlert()}>
                      {alertBusy ? 'Adding...' : 'Add Alert'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Shell>
  )
}
