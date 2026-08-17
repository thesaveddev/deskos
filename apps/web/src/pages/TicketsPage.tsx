import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useCursorPagination } from '../components/Pagination.js'
import { listTickets, slaSummary, STATUS_LABELS, formatWhen, type Ticket } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'

type Filter = 'all' | 'mine' | 'unassigned'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All open' },
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
]

export default function TicketsPage() {
  const navigate = useNavigate()
  const user = useAuth((s) => s.user)
  const [filter, setFilter] = useState<Filter>('all')
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const pagination = useCursorPagination()

  const load = useCallback(async (cursor?: string | null) => {
    setError(null)
    setLoading(true)
    try {
      const params: Record<string, string> = {}
      if (filter === 'mine') params.assignee = 'me'
      if (filter === 'unassigned') params.assignee = 'none'
      if (cursor) params.cursor = cursor
      const res = await listTickets(params)
      setTickets(res.tickets.filter((t) => filter === 'all' ? t.status !== 'resolved' && t.status !== 'closed' : true))
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets')
    }
    setLoading(false)
  }, [filter])

  useEffect(() => {
    setTickets([])
    pagination.reset()
    void load()
  }, [load])

  const handleNext = () => {
    if (nextCursor) {
      pagination.goNext(nextCursor)
      void load(nextCursor)
    }
  }

  const handlePrev = () => {
    pagination.goPrev()
    // For prev, we'd need to track all cursors — simplified: just reload from start
    void load()
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Tickets</h1>
        <Link to="/tickets/new" className="btn btn-primary btn-sm">
          New ticket
        </Link>
      </div>

      <div className="tabs" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            className={`tab${filter === f.key ? ' active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {!tickets && !error ? <div className="etch" style={{ padding: 24 }}>Loading queue…</div> : null}
      {tickets && tickets.length === 0 ? (
        <div className="empty-state">No tickets here. Enjoy the calm — or create one.</div>
      ) : null}

      {tickets && tickets.length > 0 ? (
        <table className="queue-table">
          <thead>
            <tr>
              <th className="col-num">#</th>
              <th>Subject</th>
              <th className="col-status">Status</th>
              <th className="col-prio">Prio</th>
              <th className="col-assignee">Assignee</th>
              <th className="col-sla">SLA</th>
              <th className="col-updated">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const sla = slaSummary(t)
              return (
                <tr key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/tickets/${t.id}`)}>
                  <td className="col-num mono">{t.number}</td>
                  <td className="subject-cell">{t.subject}</td>
                  <td className="col-status">
                    <span className={`status-pill status-${t.status}`}>{STATUS_LABELS[t.status] ?? t.status}</span>
                  </td>
                  <td className="col-prio mono">{t.priority.toUpperCase()}</td>
                  <td className="col-assignee">
                    {t.assignee_name ?? <span className="muted">{t.requester_id === user?.id ? '' : 'Unassigned'}</span>}
                  </td>
                  <td className={`col-sla mono sla-${sla.tone}`}>{sla.label}</td>
                  <td className="col-updated mono">{formatWhen(t.updated_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}

      {tickets && tickets.length > 0 && (
        <Pagination
          hasMore={!!nextCursor}
          onNext={handleNext}
          onPrev={pagination.canGoPrev ? handlePrev : undefined}
          loading={loading}
        />
      )}
    </Shell>
  )
}
