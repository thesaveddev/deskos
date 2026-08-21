import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Modal } from '../components/ui.js'
import { Pagination, useOffsetPagination } from '../components/Pagination.js'
import { listTickets, ticketCounts, slaSummary, STATUS_LABELS, formatWhen, bulkUpdateTickets, listTeams, listActiveTicketLocks, forceUnlockTicket, type Ticket, type Team, type LockedTicketSummary } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
import '../styles/ticket-lock.css'

type QuickFilter = 'all' | 'open' | 'mine' | 'escalated'

const QUICK_FILTERS: Array<{ key: QuickFilter; label: string }> = [
  { key: 'all', label: 'All tickets' },
  { key: 'open', label: 'Open queue' },
  { key: 'mine', label: 'My tickets' },
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
  const auth = useAuth()
  const pagination = useOffsetPagination(20)

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
  const [total, setTotal] = useState(0)
  const [teams, setTeams] = useState<Team[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [lockedTickets, setLockedTickets] = useState<LockedTicketSummary[]>([])
  const [showLockModal, setShowLockModal] = useState(false)
  const [lockListLoading, setLockListLoading] = useState(false)
  const [lockListError, setLockListError] = useState<string | null>(null)
  const canManageLocks = auth.memberships.some((membership) => membership.permissions.includes('settings.manage'))

  // Tab counts
  const [tabCounts, setTabCounts] = useState({ all: 0, open: 0, mine: 0, escalated: 0 })

  // Bulk selection
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Load teams
  useEffect(() => {
    listTeams().then((r) => setTeams(r.teams)).catch(() => {})
    // Fetch tab counts
    ticketCounts().then((c) => {
      const escalated = c.byStatus.find((s) => s.status === 'escalated')?.n ?? 0
      const all = c.byStatus.reduce((sum, s) => sum + s.n, 0)
      setTabCounts({ all, open: c.unassigned, mine: c.mine, escalated })
    }).catch(() => {})
  }, [])

  const loadLockedTickets = useCallback(async () => {
    if (!canManageLocks) return
    setLockListLoading(true)
    setLockListError(null)
    try {
      setLockedTickets((await listActiveTicketLocks()).locks)
    } catch (err) {
      setLockListError(err instanceof Error ? err.message : 'Could not load locked tickets')
    } finally {
      setLockListLoading(false)
    }
  }, [canManageLocks])

  useEffect(() => {
    void loadLockedTickets()
  }, [loadLockedTickets])

  const load = useCallback(async () => {
    setError(null)
    setLoading(true)
    try {
      const params: Record<string, string> = {}

      // Quick filters
      // Open queue is deliberately unassigned work. Once a technician claims
      // a ticket, it disappears from this queue and appears in My tickets.
      if (quickFilter === 'open') {
        params.assignee = 'none'
        params.open = 'true'
      }
      if (quickFilter === 'mine') {
        params.assignee = 'me'
        params.open = 'true'
      }
      if (quickFilter === 'escalated') params.status = 'escalated'

      // Advanced filters override the quick-filter status, while Open queue
      // and My tickets continue to enforce their ownership boundary.
      if (fStatus) params.status = fStatus
      if (quickFilter === 'open') params.assignee = 'none'
      if (quickFilter === 'mine') params.assignee = 'me'
      if (fPriority) params.priority = fPriority
      if (fTeam) params.team = fTeam
      if (fSearch) params.q = fSearch
      if (fDateFrom) params.date_from = fDateFrom
      if (fDateTo) params.date_to = fDateTo + 'T23:59:59Z'

      // Sort
      const [sortField, sortDir] = fSort.includes('_asc') ? [fSort.replace('_asc', ''), 'asc'] : [fSort, 'desc']
      params.sort = sortField
      params.dir = sortDir

      // Pagination
      params.limit = String(pagination.pageSize)
      params.offset = String(pagination.offset)

      const res = await listTickets(params)
      setTickets(res.tickets)
      setTotal(res.total ?? res.tickets.length)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tickets')
    }
    setLoading(false)
  }, [quickFilter, fStatus, fPriority, fTeam, fSearch, fDateFrom, fDateTo, fSort, pagination.page, pagination.pageSize])

  useEffect(() => {
    setSelected(new Set())
    void load()
  }, [load])

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
    try {
      await bulkUpdateTickets(Array.from(selected), updates)
      setSelected(new Set())
      void load()
    } catch { /* silent */ }
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
    pagination.reset()
  }

  const hasActiveFilters = Boolean(fStatus || fPriority || fTeam || fSearch || fDateFrom || fDateTo)
  const activeFilterCount = [fStatus, fPriority, fTeam, fSearch, fDateFrom, fDateTo].filter(Boolean).length

  const releaseLock = async (ticketId: string) => {
    try {
      await forceUnlockTicket(ticketId)
      setLockedTickets((current) => current.filter((lock) => lock.ticket_id !== ticketId))
    } catch (err) {
      setLockListError(err instanceof Error ? err.message : 'Could not release ticket lock')
    }
  }

  return (
    <Shell>
      <div className="page-head tickets-page-head">
        <h1 className="page-title">Tickets</h1>
      </div>

      {/* Keep the queue header compact; the full label lives with the filter action. */}
      <div className="tickets-toolbar">
        <div className="tickets-filter-anchor">
          <button type="button" className={`btn btn-ghost btn-sm${showFilters ? ' active' : ''}`} onClick={() => setShowFilters((open) => !open)} aria-expanded={showFilters} aria-controls="ticket-filter-card">
            <Icon name="filter" size={14} />{showFilters ? 'Close filters' : 'Filter and sort the queue'}{hasActiveFilters ? ` · ${activeFilterCount}` : ''}
          </button>
          {showFilters ? (
            <div id="ticket-filter-card" className="tickets-filter-panel tickets-filter-popover" role="dialog" aria-label="Ticket filters">
              <div className="tickets-filter-card-head"><div><strong>Filter and sort the queue</strong><span>Refine the queue without changing the table layout.</span></div><button type="button" className="btn btn-ghost btn-xs" onClick={() => setShowFilters(false)} aria-label="Close ticket filters"><Icon name="close" size={13} /></button></div>
              <div className="tickets-filter-row">
                <div className="tickets-filter-group tickets-filter-search-group">
                  <label className="tickets-filter-label" htmlFor="ticket-search-filter">Search</label>
                  <input id="ticket-search-filter" className="field-input tickets-search" placeholder="Subject or ticket number…" value={fSearch} onChange={(e) => setFSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { pagination.goToPage(0); void load() } }} />
                </div>
                <div className="tickets-filter-group">
                  <label className="tickets-filter-label" htmlFor="ticket-team-filter">Team</label>
                  <select id="ticket-team-filter" className="field-input" value={fTeam} onChange={(e) => { setFTeam(e.target.value); pagination.goToPage(0) }} aria-label="Filter tickets by team">
                    <option value="">All teams</option>
                    {teams.filter((team) => team.accepts_tickets !== false).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="tickets-filter-row">
                <div className="tickets-filter-group"><label className="tickets-filter-label">Status</label><select className="field-input" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s || 'Any'}</option>)}</select></div>
                <div className="tickets-filter-group"><label className="tickets-filter-label">Priority</label><select className="field-input" value={fPriority} onChange={(e) => setFPriority(e.target.value)}>{PRIORITIES.map((p) => <option key={p} value={p}>{p || 'Any'}</option>)}</select></div>
                <div className="tickets-filter-group tickets-filter-sort"><label className="tickets-filter-label">Sort by</label><select className="field-input" value={fSort} onChange={(e) => setFSort(e.target.value)}>{SORT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>
              </div>
              <div className="tickets-filter-row">
                <div className="tickets-filter-group"><label className="tickets-filter-label">From date</label><input className="field-input" type="date" value={fDateFrom} onChange={(e) => setFDateFrom(e.target.value)} /></div>
                <div className="tickets-filter-group"><label className="tickets-filter-label">To date</label><input className="field-input" type="date" value={fDateTo} onChange={(e) => setFDateTo(e.target.value)} /></div>
                <div className="tickets-filter-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => { pagination.goToPage(0); void load(); setShowFilters(false) }}><Icon name="check" size={14} />Apply filters</button>{hasActiveFilters ? <button type="button" className="btn btn-ghost btn-sm" onClick={clearFilters}><Icon name="close" size={14} />Clear</button> : null}</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {canManageLocks ? (
        <>
          <button type="button" className="ticket-lock-admin-icon" onClick={() => { setShowLockModal(true); void loadLockedTickets() }} data-tooltip="Manage ticket locks" aria-label={`Manage ticket locks${lockedTickets.length ? ` (${lockedTickets.length})` : ''}`}>
            <Icon name="lock" size={15} /><span className="tab-count">{lockedTickets.length}</span>
          </button>
          <Modal open={showLockModal} onClose={() => setShowLockModal(false)} title="Manage ticket locks" width={720}>
            <p className="modal-intro">Review active ticket locks and release one when an agent is unavailable. Releasing a lock does not change assignment.</p>
            {lockListError ? <div className="alert alert-error">{lockListError}</div> : null}
            {lockListLoading ? <span className="muted">Loading active locks…</span> : lockedTickets.length === 0 ? <div className="empty-state"><Icon name="unlock" size={20} /><p>No tickets are currently locked.</p></div> : <div className="ticket-lock-admin-list">{lockedTickets.map((lock) => (
              <div className="ticket-lock-admin-row" key={lock.id}>
                <button type="button" className="ticket-lock-admin-ticket" onClick={() => { setShowLockModal(false); navigate(`/tickets/${lock.ticket_id}`) }}><span className="mono">#{lock.ticket_number}</span><strong>{lock.ticket_subject}</strong></button>
                <span className="muted">Locked by {lock.locked_by_name ?? lock.locked_by_email ?? 'agent'} · expires {formatWhen(lock.expires_at)}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void releaseLock(lock.ticket_id)} disabled={lockListLoading}><Icon name="unlock" size={14} />Release</button>
              </div>
            ))}</div>}
          </Modal>
        </>
      ) : null}

      {/* Quick filter tabs */}
      <div className="tabs" role="tablist">
        {QUICK_FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={quickFilter === f.key}
            className={`tab${quickFilter === f.key ? ' active' : ''}`}
            onClick={() => { setQuickFilter(f.key); pagination.goToPage(0) }}
          >
            {f.label}
            <span className="tab-count">{tabCounts[f.key as keyof typeof tabCounts] ?? 0}</span>
          </button>
        ))}
      </div>

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
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}><Icon name="close" size={14} />Clear selection</button>
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
        <div className="queue-table-wrap">
          <table className="queue-table">
          <thead>
            <tr>
              <th className="col-check">
                <span className="ticket-queue-selection">
                  <input type="checkbox" checked={selected.size === tickets.length && tickets.length > 0} onChange={toggleSelectAll} aria-label="Select all tickets" />
                  <span className="ticket-queue-lock-header" aria-hidden="true"><Icon name="lock" size={13} /></span>
                </span>
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
                    <span className="ticket-queue-selection">
                      <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleSelect(t.id)} aria-label={`Select ticket ${t.number}`} />
                      <span
                        className={`ticket-queue-lock${t.lock_user_id ? ' is-locked' : ' is-unlocked'}`}
                        data-tooltip={t.lock_user_id ? `Locked to ${t.lock_user_name ?? 'another agent'}` : 'Ticket is unlocked'}
                        title={t.lock_user_id ? `Locked to ${t.lock_user_name ?? 'another agent'}` : 'Ticket is unlocked'}
                        aria-label={t.lock_user_id ? `Locked to ${t.lock_user_name ?? 'another agent'}` : 'Ticket is unlocked'}
                      >
                        <Icon name={t.lock_user_id ? 'lock' : 'unlock'} size={14} />
                      </span>
                    </span>
                  </td>
                  <td className="col-num mono" onClick={() => navigate(`/tickets/${t.id}`)}>{t.number}</td>
                  <td className="subject-cell" onClick={() => navigate(`/tickets/${t.id}`)}>
                    <span className="subject-cell-text">{t.subject}</span>
                  </td>
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
        </div>
      )}

      {tickets.length > 0 && (
        <Pagination
          page={pagination.page}
          pageSize={pagination.pageSize}
          totalItems={total}
          loading={loading}
          onPageChange={pagination.goToPage}
          onPageSizeChange={pagination.changeSize}
        />
      )}
    </Shell>
  )
}
