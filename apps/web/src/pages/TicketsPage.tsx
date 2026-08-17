import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Pagination, useCursorPagination } from '../components/Pagination.js'
import { listTickets, slaSummary, STATUS_LABELS, formatWhen, bulkUpdateTickets, listTeams, type Ticket, type Team } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'

type QuickFilter = 'all' | 'mine' | 'unassigned' | 'escalated'

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: 'all', label: 'All open' },
  { key: 'mine', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'escalated', label: 'Escalated' },
]

const STATUSES = ['', 'new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated', 'resolved', 'closed']
const PRIORITIES = ['', 'critical', 'high', 'medium', 'low']
const SORT_OPTIONS = [
  { value: 'created', label: 'Created (newest)' },
  { value: 'created_asc', label: 'Created (oldest)' },
  { value: 'updated', label: 'Last updated' },
  { value: 'priority', label: 'Priority' },
  { value: 'number', label: 'Ticket number' },
]

export default function TicketsPage() {
  const navigate = useNavigate()
  const user = useAuth((s) => s.user)

  // Quick filter tabs
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')

  // Advanced filters
  const [showFilters, setShowFilters] = useState(false)
  const [fStatus, setFStatus] = useState('')
  const [fPriority, setFPriority] = useState('')
  const [fTeam, setFTeam] = useState('')
  const [fSort, setFSort] = useState('created')
  const [fSearch, setFSearch] = useState('')
  const [fDateFrom, setFDateFrom] = useState('')
  const [fDateTo, setFDateTo] = useState('')

  // Data
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const pagination = useCursorPagination()

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)

  // Load teams
  useEffect(() => {
    listTeams().then((r) => setTeams(r.teams)).catch(() => {})
  }, [])

  const load = useCallback(async (cursor?: string | null) => {
    setError(null)
    setLoading(true)
    try {
      const params: Record<string, string> = {}

      // Quick filters
      if (quickFilter === 'mine') params.assignee = 'me'
      if (quickFilter === 'unassigned') params.assignee = 'none'
      if (quickFilter === 'escalated') params.status = 'escalated'
      if (quickFilter === 'all' && !fStatus) params.status = 'open'

      // Advanced filters override quick filter status
      if (fStatus) params.status = fStatus
      if (fPriority) params.priority = fPriority
      if (fTeam) params.team = fTeam
      if (fSearch) params.q = fSearch
      if (fDateFrom) params.date_from = fDateFrom
      if (fDateTo) params.date_to = fDateTo + 'T23:59:59Z'

      // Sort
      const [sortField, sortDir] = fSort.includes('_asc') ? [fSort.replace('_asc', ''), 'asc'] : [fSort, 'desc']
      params.sort = sortField
      params.dir = sortDir

      if (cursor) params.cursor = cursor

      const res = await listTickets(params)
      setTickets(res.tickets)
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets')
    }
    setLoading(false)
  }, [quickFilter, fStatus, fPriority, fTeam, fSearch, fDateFrom, fDateTo, fSort])

  useEffect(() => {
    setTickets([])
    setSelected(new Set())
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
    void load()
  }

  // Bulk actions
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSelectAll = () => {
    if (selected.size === tickets.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(tickets.map((t) => t.id)))
    }
  }

  const handleBulk = async (updates: { status?: string; priority?: string; assignee_id?: string }) => {
    if (selected.size === 0) return
    setBulkBusy(true)
    try {
      await bulkUpdateTickets(Array.from(selected), updates)
      setSelected(new Set())
      void load()
    } catch { /* silent */ }
    setBulkBusy(false)
  }

  const clearFilters = () => {
    setFStatus('')
    setFPriority('')
    setFTeam('')
    setFSearch('')
    setFDateFrom('')
    setFDateTo('')
    setFSort('created')
    setQuickFilter('all')
  }

  const hasActiveFilters = fStatus || fPriority || fTeam || fSearch || fDateFrom || fDateTo

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Tickets</h1>
        <div className="tickets-head-actions">
          <button className="btn btn-ghost btn-sm" onClick={() => setShowFilters(!showFilters)}>
            {showFilters ? 'Hide filters' : '⚙ Filters'}
          </button>
          <Link to="/tickets/new" className="btn btn-primary btn-sm">New ticket</Link>
        </div>
      </div>

      {/* Search bar */}
      <div className="tickets-search-row">
        <input
          className="field-input tickets-search"
          placeholder="Search by subject or ticket number…"
          value={fSearch}
          onChange={(e) => setFSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load()}
        />
      </div>

      {/* Quick filter tabs */}
      <div className="tabs" role="tablist">
        {QUICK_FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={quickFilter === f.key}
            className={`tab${quickFilter === f.key ? ' active' : ''}`}
            onClick={() => setQuickFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Advanced filter panel */}
      {showFilters && (
        <div className="tickets-filter-panel">
          <div className="tickets-filter-row">
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">Status</label>
              <select className="field-input" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
                {STATUSES.map((s) => <option key={s} value={s}>{s || 'Any'}</option>)}
              </select>
            </div>
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">Priority</label>
              <select className="field-input" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p || 'Any'}</option>)}
              </select>
            </div>
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">Team</label>
              <select className="field-input" value={fTeam} onChange={(e) => setFTeam(e.target.value)}>
                <option value="">Any team</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">Sort by</label>
              <select className="field-input" value={fSort} onChange={(e) => setFSort(e.target.value)}>
                {SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="tickets-filter-row">
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">From date</label>
              <input className="field-input" type="date" value={fDateFrom} onChange={(e) => setFDateFrom(e.target.value)} />
            </div>
            <div className="tickets-filter-group">
              <label className="tickets-filter-label">To date</label>
              <input className="field-input" type="date" value={fDateTo} onChange={(e) => setFDateTo(e.target.value)} />
            </div>
            <div className="tickets-filter-group tickets-filter-actions">
              <button className="btn btn-primary btn-sm" onClick={() => void load()}>Apply</button>
              {hasActiveFilters && <button className="btn btn-ghost btn-sm" onClick={clearFilters}>Clear all</button>}
            </div>
          </div>
        </div>
      )}

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="tickets-bulk-bar">
          <span className="tickets-bulk-count">{selected.size} selected</span>
          <select className="field-input field-input-sm" onChange={(e) => { if (e.target.value) { handleBulk({ status: e.target.value }); e.target.value = '' } }}>
            <option value="">Change status…</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select className="field-input field-input-sm" onChange={(e) => { if (e.target.value) { handleBulk({ priority: e.target.value }); e.target.value = '' } }}>
            <option value="">Change priority…</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())} disabled={bulkBusy}>Clear selection</button>
        </div>
      )}

      {error ? <div className="alert alert-error">{error}</div> : null}
      {loading ? <div className="etch" style={{ padding: 24 }}>Loading tickets…</div> : null}

      {!loading && tickets.length === 0 && (
        <div className="empty-state">
          {hasActiveFilters || quickFilter !== 'all' ? 'No tickets match your filters.' : 'No tickets yet. Create one to get started.'}
        </div>
      )}

      {tickets.length > 0 && (
        <table className="queue-table">
          <thead>
            <tr>
              <th className="col-check">
                <input type="checkbox" checked={selected.size === tickets.length && tickets.length > 0} onChange={toggleSelectAll} />
              </th>
              <th className="col-num">#</th>
              <th>Subject</th>
              <th className="col-status">Status</th>
              <th className="col-prio">Prio</th>
              <th className="col-team">Team</th>
              <th className="col-assignee">Assignee</th>
              <th className="col-sla">SLA</th>
              <th className="col-updated">Updated</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => {
              const sla = slaSummary(t)
              return (
                <tr key={t.id} className={selected.has(t.id) ? 'row-selected' : ''}>
                  <td className="col-check" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} />
                  </td>
                  <td className="col-num mono" onClick={() => navigate(`/tickets/${t.id}`)}>{t.number}</td>
                  <td className="subject-cell" onClick={() => navigate(`/tickets/${t.id}`)}>{t.subject}</td>
                  <td className="col-status" onClick={() => navigate(`/tickets/${t.id}`)}>
                    <span className={`status-pill status-${t.status}`}>{STATUS_LABELS[t.status] ?? t.status}</span>
                  </td>
                  <td className="col-prio mono" onClick={() => navigate(`/tickets/${t.id}`)}>{t.priority.toUpperCase()}</td>
                  <td className="col-team" onClick={() => navigate(`/tickets/${t.id}`)}>{t.team_name ?? <span className="muted">—</span>}</td>
                  <td className="col-assignee" onClick={() => navigate(`/tickets/${t.id}`)}>
                    {t.assignee_name ?? <span className="muted">Unassigned</span>}
                  </td>
                  <td className={`col-sla mono sla-${sla.tone}`} onClick={() => navigate(`/tickets/${t.id}`)}>{sla.label}</td>
                  <td className="col-updated mono" onClick={() => navigate(`/tickets/${t.id}`)}>{formatWhen(t.updated_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {tickets.length > 0 && (
        <Pagination
          hasMore={!!nextCursor}
          onNext={handleNext}
          onPrev={pagination.page > 0 ? handlePrev : undefined}
        />
      )}
    </Shell>
  )
}
