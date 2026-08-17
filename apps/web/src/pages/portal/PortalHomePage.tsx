import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Alert } from '../../components/ui.js'
import { formatWhen } from '../../lib/tickets.js'
import { portalTickets, type PortalTicket } from '../../lib/portal.js'

export default function PortalHomePage() {
  const [tickets, setTickets] = useState<PortalTicket[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setTickets((await portalTickets()).tickets)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your requests')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <PortalShell>
      <div className="page-head">
        <h1 className="page-title">My requests</h1>
        <div className="page-actions">
          <Link to="/portal/new" className="btn btn-primary btn-sm">New request</Link>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {tickets === null ? (
        <span className="etch">Loading your requests…</span>
      ) : tickets.length === 0 ? (
        <div className="empty-state">
          <p>You don&apos;t have any requests yet.</p>
          <Link to="/portal/new" className="btn btn-primary">Submit your first request</Link>
        </div>
      ) : (
        <div className="queue-table">
          <table>
            <thead>
              <tr>
                <th className="col-num">#</th>
                <th>Subject</th>
                <th className="col-status">Status</th>
                <th className="col-updated">Last updated</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id}>
                  <td className="col-num mono">#{t.number}</td>
                  <td>
                    <Link to={`/portal/tickets/${t.number}`} className="subject-cell">
                      {t.subject}
                    </Link>
                  </td>
                  <td className="col-status">
                    <span className={`status-pill status-${t.status}`}>{t.status.replace('_', ' ')}</span>
                  </td>
                  <td className="col-updated muted mono">{formatWhen(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </PortalShell>
  )
}
