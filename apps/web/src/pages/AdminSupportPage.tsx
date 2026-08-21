import { useCallback, useEffect, useMemo, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Modal, PageHeader } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { api } from '../lib/api.js'

interface SupportTicket {
  id: number
  number: number
  subject: string
  description: string | null
  category: string
  priority: string
  status: string
  assigned_to: string | null
  user_name?: string
  user_email?: string
  tenant_name?: string
  created_at: string
  updated_at: string
}
interface SupportThread { id: number; kind: string; body: string; author_name?: string; created_at: string }

const STATUS = ['open', 'in_progress', 'waiting_user', 'resolved', 'closed']
const PRIORITIES = ['p1', 'p2', 'p3', 'p4']

function when(value: string) { return new Date(value).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) }

export default function AdminSupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [selected, setSelected] = useState<SupportTicket | null>(null)
  const [threads, setThreads] = useState<SupportThread[]>([])
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const result = await api('/admin/support-tickets') as { tickets: SupportTicket[] }
      setTickets(result.tickets)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not load support queue') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const visible = useMemo(() => tickets.filter((ticket) => {
    const matchesStatus = !status || ticket.status === status
    const haystack = `${ticket.number} ${ticket.subject} ${ticket.user_name ?? ''} ${ticket.user_email ?? ''} ${ticket.tenant_name ?? ''}`.toLowerCase()
    return matchesStatus && haystack.includes(query.trim().toLowerCase())
  }), [query, status, tickets])

  const openTicket = async (ticket: SupportTicket) => {
    setSelected(ticket); setThreads([]); setError(null)
    try { setThreads(((await api(`/support/tickets/${ticket.id}`)) as { threads: SupportThread[] }).threads) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load ticket conversation') }
  }

  const update = async (patch: { status?: string; priority?: string }) => {
    if (!selected || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api(`/admin/support-tickets/${selected.id}`, { method: 'PATCH', body: patch }) as { ticket: SupportTicket }
      setSelected(result.ticket); setTickets((current) => current.map((ticket) => ticket.id === result.ticket.id ? { ...ticket, ...result.ticket } : ticket)); setNotice('Ticket updated.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update ticket') }
    finally { setBusy(false) }
  }

  const sendReply = async () => {
    if (!selected || !reply.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api(`/admin/support-tickets/${selected.id}/reply`, { method: 'POST', body: { body: reply.trim(), kind: 'message' } }) as { thread: SupportThread }
      setThreads((current) => [...current, result.thread]); setReply(''); setNotice('Reply sent.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send reply') }
    finally { setBusy(false) }
  }

  return <Shell>
    <PageHeader title="Platform support" subtitle="Triage product support requests, respond to customers, and keep the queue moving." actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()}><Icon name="refresh" size={14} />Refresh</button>} />
    {error ? <Alert kind="error">{error}</Alert> : null}
    {notice ? <Alert kind="info">{notice}</Alert> : null}
    <div className="support-admin-summary"><div><strong>{tickets.filter((ticket) => ['open', 'in_progress'].includes(ticket.status)).length}</strong><span>Needs triage</span></div><div><strong>{tickets.filter((ticket) => ticket.status === 'waiting_user').length}</strong><span>Waiting on customer</span></div><div><strong>{tickets.filter((ticket) => ticket.priority === 'p1' && ticket.status !== 'closed').length}</strong><span>Critical</span></div><div><strong>{tickets.length}</strong><span>Total loaded</span></div></div>
    <div className="support-admin-toolbar"><div className="device-search-wrap"><Icon name="search" size={15} /><input className="field-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ticket, customer, or organization…" /></div><select className="field-input support-admin-status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{STATUS.map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}</select></div>
    {loading ? <div className="device-loading"><span className="etch">Loading support queue…</span></div> : visible.length === 0 ? <div className="empty-state"><Icon name="ticket" size={24} /><strong>No support tickets match</strong><span>Try a different search or status filter.</span></div> : <div className="support-admin-queue">{visible.map((ticket) => <button key={ticket.id} className={`support-admin-row${selected?.id === ticket.id ? ' active' : ''}`} onClick={() => void openTicket(ticket)}><span className={`status-pill status-${ticket.status}`}>{ticket.status.replace('_', ' ')}</span><span className="support-admin-row-subject"><strong>#{ticket.number} · {ticket.subject}</strong><small>{ticket.user_name || ticket.user_email || 'Unknown customer'} · {ticket.tenant_name || 'No organization'}</small></span><span className={`priority-mark priority-${ticket.priority}`}>{ticket.priority.toUpperCase()}</span><span className="mono muted">{when(ticket.updated_at)}</span></button>)}</div>}

    <Modal open={Boolean(selected)} onClose={() => setSelected(null)} title={selected ? `Ticket #${selected.number}` : 'Support ticket'} width={760} footer={<button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button>}>
      {selected ? <div className="support-admin-detail"><div className="support-admin-detail-head"><div><h2>{selected.subject}</h2><p className="muted">{selected.user_name || selected.user_email} · {selected.tenant_name || 'No organization'} · opened {when(selected.created_at)}</p></div><div className="support-admin-detail-controls"><select className="field-input" value={selected.status} disabled={busy} onChange={(event) => void update({ status: event.target.value })}>{STATUS.map((item) => <option key={item} value={item}>{item.replace('_', ' ')}</option>)}</select><select className="field-input" value={selected.priority} disabled={busy} onChange={(event) => void update({ priority: event.target.value })}>{PRIORITIES.map((item) => <option key={item} value={item}>{item.toUpperCase()}</option>)}</select></div></div>{selected.description ? <div className="support-admin-description">{selected.description}</div> : null}<div className="support-threads">{threads.map((thread) => <article className={`support-thread ${thread.kind}`} key={thread.id}><div className="support-thread-head"><strong>{thread.author_name || 'ReyDesk support'}</strong><span className="muted">{when(thread.created_at)}</span></div><p>{thread.body}</p></article>)}</div><div className="support-admin-reply"><textarea className="field-input" rows={4} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write a reply to the customer…" /><button className="btn btn-primary btn-sm" disabled={busy || !reply.trim()} onClick={() => void sendReply()}><Icon name="send" size={14} />{busy ? 'Sending…' : 'Send reply'}</button></div></div> : null}
    </Modal>
  </Shell>
}
