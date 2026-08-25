import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert } from '../../components/ui.js'
import { formatWhen, STATUS_LABELS } from '../../lib/tickets.js'
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
      <div className="portal-queue">
        <div className="portal-queue-header">
          <h2>My requests</h2>
          <Link to="/portal/new" className="btn btn-primary btn-sm">
            <Icon name="add" size={14} /> New request
          </Link>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        {tickets === null ? (
          <span className="etch">Loading your requests…</span>
        ) : tickets.length === 0 ? (
          <div className="portal-empty">
            <div className="portal-empty-icon">
              <Icon name="ticket" size={24} />
            </div>
            <h3>No requests yet</h3>
            <p>When you submit a support request, it will appear here so you can track its progress.</p>
            <Link to="/portal/new" className="btn btn-primary btn-sm">Submit your first request</Link>
          </div>
        ) : (
          <div style={{ border: '1px solid var(--line-1)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            <table className="portal-queue-table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>#</th>
                  <th>Subject</th>
                  <th style={{ width: 120 }}>Status</th>
                  <th style={{ width: 140 }}>Last updated</th>
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>#{t.number}</td>
                    <td>
                      <Link to={`/portal/tickets/${t.number}`} className="subject-link">
                        {t.subject}
                      </Link>
                    </td>
                    <td>
                      <span className={`status-pill status-${t.status}`}>
                        {STATUS_LABELS[t.status] ?? t.status.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="mono" style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                      {formatWhen(t.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </PortalShell>
  )
}
