import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { useAuth } from '../lib/auth.js'
import { ticketCounts } from '../lib/tickets.js'

interface Counts {
  mine: number
  unassigned: number
  slaRisk: number
}

export default function HomePage() {
  const auth = useAuth()
  const [counts, setCounts] = useState<Counts | null>(null)

  useEffect(() => {
    ticketCounts()
      .then((c) => setCounts(c))
      .catch(() => setCounts(null))
  }, [])

  if (!auth.user) return null

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Good to see you, {auth.user.name.split(' ')[0]}.</h1>
      </div>

      <div className="stat-row">
        <div className="stat-card">
          <span className="stat-value mono">{counts ? counts.mine : '—'}</span>
          <span className="stat-label">Assigned to you</span>
        </div>
        <div className="stat-card">
          <span className="stat-value mono">{counts ? counts.unassigned : '—'}</span>
          <span className="stat-label">Unassigned</span>
        </div>
        <div className="stat-card">
          <span className={`stat-value mono${counts && counts.slaRisk > 0 ? ' sla-crit' : ''}`}>
            {counts ? counts.slaRisk : '—'}
          </span>
          <span className="stat-label">SLA at risk</span>
        </div>
      </div>

      <div className="home-links">
        <Link to="/tickets" className="btn btn-primary">Open the queue</Link>
        <Link to="/tickets/new" className="btn btn-ghost">Create a ticket</Link>
      </div>

      <p className="home-note">
        Memberships: {auth.memberships.map((m) => `${m.tenant.name} (${m.orgRole})`).join(' · ')}.
        Next up: remote sessions and the persistent technician console.
      </p>
    </Shell>
  )
}
