import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchAll } from '../lib/tickets.js'
import { useAuth } from '../lib/auth.js'

interface ListItem {
  id: string
  kind: 'ticket' | 'user' | 'action'
  label: string
  sub?: string
  action: () => void
}

export function CommandPalette() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [ticketHits, setTicketHits] = useState<Array<{ id: string; number: number; subject: string; status: string }>>([])
  const [userHits, setUserHits] = useState<Array<{ id: string; name: string; email: string }>>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => {
    setOpen(false)
    setQuery('')
    setTicketHits([])
    setUserHits([])
    setActive(0)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    let cancelled = false
    const q = query.trim()
    if (q.length < 2) {
      setTicketHits([])
      setUserHits([])
      return
    }
    const t = setTimeout(() => {
      searchAll(q)
        .then((res) => {
          if (cancelled) return
          setTicketHits(res.tickets)
          setUserHits(res.users)
        })
        .catch(() => {
          if (cancelled) return
          setTicketHits([])
          setUserHits([])
        })
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query])

  const actions = useMemo<ListItem[]>(() => [
    { id: 'Tickets', kind: 'action', label: 'Open ticket queue', sub: 'Go to tickets', action: () => navigate('/tickets') },
    { id: 'NewTicket', kind: 'action', label: 'Create a ticket', sub: 'New ticket', action: () => navigate('/tickets/new') },
    { id: 'Home', kind: 'action', label: 'Go home', sub: 'Dashboard', action: () => navigate('/') },
    { id: 'Reports', kind: 'action', label: 'Open reports', sub: 'Analytics', action: () => navigate('/reports') },
    { id: 'SignOut', kind: 'action', label: 'Sign out', sub: 'End session', action: () => void auth.logout().then(() => navigate('/login')) },
  ], [navigate, auth])

  const searchResults = useMemo<ListItem[]>(() => {
    if (!query.trim()) return []
    const tickets: ListItem[] = ticketHits.map((t) => ({
      id: `t:${t.id}`, kind: 'ticket',
      label: `#${t.number} ${t.subject}`, sub: t.status,
      action: () => { close(); navigate(`/tickets/${t.id}`) },
    }))
    const users: ListItem[] = userHits.map((u) => ({
      id: `u:${u.id}`, kind: 'user', label: u.name, sub: u.email,
      action: () => { close(); navigate('/tickets') },
    }))
    return [...tickets, ...users]
  }, [query, ticketHits, userHits, navigate])

  const items = query.trim() ? searchResults : actions

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); close() }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.action() }
  }

  return (
    <>
      <button className="palette-trigger" onClick={() => setOpen(true)} title="Command palette (Ctrl/Cmd+K)">
        <span className="mono">⌘K</span>
        <span className="muted">Search &amp; run…</span>
      </button>

      {open ? (
        <div className="palette-overlay" onClick={close}>
          <div className="palette-panel" onClick={(e) => e.stopPropagation()}>
            <div className="palette-bar">
              <input
                ref={inputRef}
                className="palette-input"
                placeholder="Search tickets, people… or run a command"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0) }}
                onKeyDown={onInputKeyDown}
              />
            </div>
            <div className="palette-list">
              {items.length === 0 ? (
                <div className="palette-empty">No matches.</div>
              ) : (
                items.map((item, i) => (
                  <button
                    key={item.id}
                    className={`palette-item${i === active ? ' active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => item.action()}
                  >
                    <span className={`palette-kind kind-${item.kind}`}>
                      {item.kind === 'ticket' ? '#' : item.kind === 'user' ? '◉' : '→'}
                    </span>
                    <span className="palette-label">{item.label}</span>
                    {item.sub ? <span className="palette-sub muted">{item.sub}</span> : null}
                  </button>
                ))
              )}
            </div>
            <div className="palette-foot etch">↑↓ navigate · Enter select · Esc close</div>
          </div>
        </div>
      ) : null}
    </>
  )
}