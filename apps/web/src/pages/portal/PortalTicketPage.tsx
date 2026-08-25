import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert } from '../../components/ui.js'
import { formatWhen, STATUS_LABELS } from '../../lib/tickets.js'
import { portalTicket, replyPortalTicket, resolvePortalTicket, portalAttachments, uploadPortalAttachment, type PortalThread, type PortalTicket, type PortalAttachment } from '../../lib/portal.js'

export default function PortalTicketPage() {
  const { number } = useParams<{ number: string }>()
  const [ticket, setTicket] = useState<PortalTicket | null>(null)
  const [threads, setThreads] = useState<PortalThread[]>([])
  const [attachments, setAttachments] = useState<PortalAttachment[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!number) return
    try {
      const res = await portalTicket(Number(number))
      setTicket(res.ticket)
      setThreads(res.threads)
      const attRes = await portalAttachments(Number(number))
      setAttachments(attRes.attachments)
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

  const addFiles = (incoming: FileList | File[]) => {
    setPendingFiles((prev) => [...prev, ...Array.from(incoming)])
  }

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const sendReply = async () => {
    if ((!draft.trim() && pendingFiles.length === 0) || busy) return
    setBusy(true)
    setError(null)
    try {
      if (draft.trim()) {
        await replyPortalTicket(ticket.number, draft.trim())
      }
      // Upload files
      for (const file of pendingFiles) {
        try {
          await uploadPortalAttachment(ticket.number, file)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'File upload failed')
        }
      }
      setDraft('')
      setPendingFiles([])
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

      {/* Attachments bar */}
      {attachments.length > 0 ? (
        <div className="portal-attachments-bar">
          <Icon name="paperclip" size={14} />
          <span className="portal-attachments-label">{attachments.length} file{attachments.length !== 1 ? 's' : ''}</span>
          <div className="portal-attachments-list">
            {attachments.map((att) => (
              <a
                key={att.id}
                href={`/api/v1/portal/attachments/${att.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="portal-attachment-chip"
                title={`${att.filename} — ${formatSize(att.size_bytes)}`}
              >
                <Icon name="paperclip" size={12} />
                <span>{att.filename}</span>
                <small>{formatSize(att.size_bytes)}</small>
              </a>
            ))}
          </div>
        </div>
      ) : null}

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

        {/* Pending files */}
        {pendingFiles.length > 0 ? (
          <div className="portal-attach-list" style={{ padding: '8px 12px', borderTop: '1px solid var(--border)' }}>
            {pendingFiles.map((f, i) => (
              <div key={`${f.name}-${i}`} className="portal-attach-item">
                <Icon name="paperclip" size={14} />
                <span className="portal-attach-name">{f.name}</span>
                <span className="portal-attach-size">{formatSize(f.size)}</span>
                <button type="button" className="portal-attach-remove" onClick={() => removePendingFile(i)} aria-label="Remove file">
                  <Icon name="close" size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="portal-composer-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => fileInputRef.current?.click()}
              title="Attach file"
            >
              <Icon name="paperclip" size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
            />
            <span className="portal-composer-hint">Ctrl+Enter to send</span>
          </div>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || (!draft.trim() && pendingFiles.length === 0)}
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
