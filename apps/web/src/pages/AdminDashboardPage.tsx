import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, PageHeader } from '../components/ui.js'
import { api } from '../lib/api.js'

interface PlatformMetrics {
  orgs: { total: number; active_30d: number }
  users: { total: number; active_30d: number }
  devices: { total: number; online: number }
  sessions: { total: number; active: number; last_30d: number }
  tickets: { total: number; open: number; resolved_30d: number }
  support_tickets: { total: number; open: number }
  recent_signups: { date: string; count: number }[]
}

interface Org {
  id: string
  name: string
  slug: string
  created_at: string
  user_count: number
  device_count: number
}

export default function AdminDashboardPage() {
  const [metrics, setMetrics] = useState<PlatformMetrics | null>(null)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [m, o] = await Promise.all([
        api('/admin/metrics') as Promise<PlatformMetrics>,
        api('/admin/orgs') as Promise<{ orgs: Org[] }>,
      ])
      setMetrics(m)
      setOrgs(o.orgs)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin data. You may not have platform admin access.')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Shell><span className="etch">Loading admin dashboard…</span></Shell>
  if (error) return <Shell><Alert kind="error">{error}</Alert></Shell>
  if (!metrics) return null

  return (
    <Shell>
      <PageHeader title="Platform Admin" subtitle="Overview of all ReyDesk organizations, users, and system health." actions={<Link className="btn btn-primary btn-sm" to="/admin/support">Open support queue</Link>} />

      {/* Top stats */}
      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-value">{metrics.orgs.total}</div>
          <div className="stat-label">Organizations</div>
          <div className="home-note" style={{ color: 'var(--ok)' }}>+{metrics.orgs.active_30d} new (30d)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{metrics.users.total}</div>
          <div className="stat-label">Users</div>
          <div className="home-note" style={{ color: 'var(--ok)' }}>{metrics.users.active_30d} active (30d)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{metrics.devices.total}</div>
          <div className="stat-label">Devices</div>
          <div className="home-note" style={{ color: 'var(--ok)' }}>{metrics.devices.online} online now</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{metrics.sessions.active}</div>
          <div className="stat-label">Live sessions</div>
          <div className="home-note">{metrics.sessions.last_30d} total (30d)</div>
        </div>
      </div>

      <div style={{ height: 16 }} />

      {/* Secondary stats */}
      <div className="stat-row">
        <div className="stat-card">
          <div className="stat-value">{metrics.tickets.open}</div>
          <div className="stat-label">Open tickets (all orgs)</div>
          <div className="home-note">{metrics.tickets.total} total · {metrics.tickets.resolved_30d} resolved (30d)</div>
        </div>
        <div className="stat-card">
          <div className="stat-value" style={{ color: metrics.support_tickets.open > 0 ? 'var(--warn)' : undefined }}>
            {metrics.support_tickets.open}
          </div>
          <div className="stat-label">Open support tickets</div>
          <div className="home-note">{metrics.support_tickets.total} total</div>
        </div>
      </div>

      <div style={{ height: 20 }} />

      {/* Signups chart (simple bar representation) */}
      {metrics.recent_signups.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>New signups (last 30 days)</h2>
          <div className="sparkline" style={{ height: 64, marginBottom: 20 }}>
            {metrics.recent_signups.slice().reverse().map((s) => {
              const max = Math.max(...metrics.recent_signups.map((x) => x.count), 1)
              return (
                <div key={s.date} className="spark-bar">
                  <div className="spark-bar-fill" style={{ height: `${(s.count / max) * 100}%` }} title={`${s.date}: ${s.count}`} />
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Organizations table */}
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Organizations ({orgs.length})</h2>
      <div className="device-table-wrap">
        <table className="device-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Users</th>
              <th>Devices</th>
              <th style={{ textAlign: 'right' }}>Created</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((org) => (
              <tr key={org.id}>
                <td style={{ fontWeight: 500 }}>{org.name}</td>
                <td className="mono">{org.slug}</td>
                <td>{org.user_count}</td>
                <td>{org.device_count}</td>
                <td style={{ textAlign: 'right' }} className="mono muted">
                  {new Date(org.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Shell>
  )
}
