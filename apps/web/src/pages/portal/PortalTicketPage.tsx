import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
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
      <div className="ticket-head">
        <div className="ticket-head-main">
          <div className="ticket-id-row">
            <span className="mono ticket-number">#{ticket.number}</span>
            <span className={`status-pill status-${ticket.status}`}>{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
          </div>
          <h1 className="ticket-subject">{ticket.subject}</h1>
          <div className="ticket-meta mono">
            opened {formatWhen(ticket.created_at)}
            {ticket.resolved_at ? ` · resolved ${formatWhen(ticket.resolved_at)}` : ''}
          </div>
        </div>
        {!closed ? (
          <div className="ticket-actions">
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resolve()}>
              Mark as resolved
            </button>
          </div>
        ) : null}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="timeline">
        {threads.map((th) => (
          <div key={th.id} className={`timeline-entry kind-${th.kind === 'message' ? 'message' : 'system'}`}>
            <div className="timeline-meta mono">
              {th.kind === 'system_event' ? (
                <span>{th.body} · {formatWhen(th.created_at)}</span>
              ) : (
                <>
                  <span className="timeline-author">{th.author_name ?? 'Support'}</span>
                  <span>{formatWhen(th.created_at)}</span>
                </>
              )}
            </div>
            {th.kind !== 'system_event' ? <div className="timeline-body">{th.body}</div> : null}
          </div>
        ))}
      </div>

      {closed ? (
        <div className="empty-state">
          <p>This request is resolved. If the issue comes back, just reply below to reopen it.</p>
        </div>
      ) : (
        <div className="composer">
          <div className="composer-tabs">
            <span className="composer-tab active">Reply</span>
          </div>
          <textarea
            className="composer-input"
            rows={4}
            placeholder="Add a reply to your request…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void sendReply()
            }}
          />
          <div className="composer-foot">
            <span className="etch">Ctrl+Enter to send</span>
            <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={() => void sendReply()}>
              Send reply
            </button>
          </div>
        </div>
      )}

      <p className="home-note">
        <Link to="/portal">← Back to my requests</Link>
      </p>
    </PortalShell>
  )
}
