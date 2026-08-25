import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert } from '../../components/ui.js'
import { formatWhen, STATUS_LABELS } from '../../lib/tickets.js'
import { portalTicket, replyPortalTicket, resolvePortalTicket, type PortalThread, type PortalTicket } from '../../lib/portal.js'

export default function PortalTicketPage() {
  const { number } = useParams<{ number: string }>()
  const [ticket, setTicket] = useState<PortalTicket | null>(null)
  const [threads, setThreads] = useState<PortalThread[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!number) return
    try {
      const res = await portalTicket(Number(number))
      setTicket(res.ticket)
      setThreads(res.threads)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load request')
    }
  }, [number])

  useEffect(() => {
    void load()
  }, [load])

  if (!ticket) {
    return (
      <PortalShell>
        {error ? <Alert kind="error">{error}</Alert> : <span className="etch">Loading request…</span>}
      </PortalShell>
    )
  }

  const closed = ticket.status === 'resolved' || ticket.status === 'closed'

  const sendReply = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await replyPortalTicket(ticket.number, draft.trim())
      setDraft('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reply failed')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await resolvePortalTicket(ticket.number)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve the request')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PortalShell>
      {/* Ticket header */}
      <div className="portal-ticket-head">
        <div>
          <div className="portal-ticket-id">
            <span className="mono" style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text-3)' }}>#{ticket.number}</span>
            <span className={`status-pill status-${ticket.status}`}>
              {STATUS_LABELS[ticket.status] ?? ticket.status.replace('_', ' ')}
            </span>
          </div>
          <h1 className="portal-ticket-subject">{ticket.subject}</h1>
          <div className="portal-ticket-meta">
            opened {formatWhen(ticket.created_at)}
            {ticket.resolved_at ? ` · resolved ${formatWhen(ticket.resolved_at)}` : ''}
          </div>
        </div>
        {!closed ? (
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve()}>
            <Icon name="check" size={14} /> Mark as resolved
          </button>
        ) : null}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {/* Timeline */}
      <div className="portal-timeline">
        {threads.map((th) => (
          <div
            key={th.id}
            className={`portal-timeline-entry ${th.kind === 'system_event' ? 'kind-system' : ''}`}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {th.kind === 'system_event' ? (
                <span className="portal-timeline-time">{th.body} · {formatWhen(th.created_at)}</span>
              ) : (
                <>
                  <span className="portal-timeline-author">{th.author_name ?? 'Support'}</span>
                  <span className="portal-timeline-time">{formatWhen(th.created_at)}</span>
                </>
              )}
            </div>
            {th.kind !== 'system_event' ? <div className="portal-timeline-body">{th.body}</div> : null}
          </div>
        ))}
      </div>

      {/* Composer */}
      {closed ? (
        <div className="portal-empty" style={{ padding: '32px 20px' }}>
          <Icon name="check" size={20} />
          <p>This request is resolved. If the issue comes back, just reply below to reopen it.</p>
        </div>
      ) : null}

      <div className="portal-composer">
        <textarea
          className="portal-composer-input"
          placeholder={closed ? 'Reply to reopen this request…' : 'Add a reply to your request…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void sendReply()
          }}
        />
        <div className="portal-composer-foot">
          <span className="portal-composer-hint">Ctrl+Enter to send</span>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || !draft.trim()}
            onClick={() => void sendReply()}
          >
            {busy ? 'Sending…' : 'Send reply'}
          </button>
        </div>
      </div>

      <p style={{ marginTop: 20 }}>
        <Link to="/portal" style={{ color: 'var(--text-3)', fontSize: 13 }}>← Back to my requests</Link>
      </p>
    </PortalShell>
  )
}
