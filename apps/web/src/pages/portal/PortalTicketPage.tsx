import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert } from '../../components/ui.js'
import { formatWhen, STATUS_LABELS } from '../../lib/tickets.js'
import { portalTicket, replyPortalTicket, resolvePortalTicket, portalAttachments, uploadPortalAttachment, downloadPortalAttachment, portalTicketRating, submitPortalRating, type PortalThread, type PortalTicket, type PortalAttachment, type TicketRating } from '../../lib/portal.js'

export default function PortalTicketPage() {
  const { number } = useParams<{ number: string }>()
  const [ticket, setTicket] = useState<PortalTicket | null>(null)
  const [threads, setThreads] = useState<PortalThread[]>([])
  const [attachments, setAttachments] = useState<PortalAttachment[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloadBusy, setDownloadBusy] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [csatRating, setCsatRating] = useState<TicketRating | null>(null)
  const [ratingDraft, setRatingDraft] = useState(0)
  const [ratingComment, setRatingComment] = useState('')
  const [ratingBusy, setRatingBusy] = useState(false)

  const load = useCallback(async () => {
    if (!number) return
    try {
      const res = await portalTicket(Number(number))
      setTicket(res.ticket)
      setThreads(res.threads)
      const attRes = await portalAttachments(Number(number))
      setAttachments(attRes.attachments)
      const ratingRes = await portalTicketRating(Number(number))
      setCsatRating(ratingRes.rating)
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

  const submitRating = async () => {
    if (ratingBusy || ratingDraft < 1) return
    setRatingBusy(true)
    setError(null)
    try {
      const res = await submitPortalRating(ticket.number, { rating: ratingDraft, comment: ratingComment.trim() || undefined })
      setCsatRating(res.rating)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit your rating')
    } finally {
      setRatingBusy(false)
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
              <button
                key={att.id}
                type="button"
                className="portal-attachment-chip"
                title={`${att.filename} — ${formatSize(att.size_bytes)}`}
                disabled={downloadBusy === att.id}
                onClick={() => {
                  setDownloadBusy(att.id)
                  void downloadPortalAttachment(att.id, att.filename)
                    .catch((err) => setError(err instanceof Error ? err.message : 'Download failed'))
                    .finally(() => setDownloadBusy(null))
                }}
              >
                <Icon name="download" size={12} />
                <span>{att.filename}</span>
                <small>{downloadBusy === att.id ? 'Downloading…' : formatSize(att.size_bytes)}</small>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* CSAT survey — shown only when the request is resolved and not yet rated */}
      {closed && !csatRating ? (
        <div className="portal-csat-card">
          <div className="portal-csat-head">
            <Icon name="star" size={16} />
            <strong>How did we do?</strong>
          </div>
          <p className="portal-csat-question">How satisfied are you with the resolution of this request?</p>
          <div className="portal-csat-stars" role="radiogroup" aria-label="Satisfaction rating">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={ratingDraft === value}
                aria-label={`${value} out of 5`}
                className={`portal-csat-star${ratingDraft >= value ? ' selected' : ''}`}
                onClick={() => setRatingDraft(value)}
                disabled={ratingBusy}
              >
                <Icon name="star" size={20} />
              </button>
            ))}
            <span className="portal-csat-star-label">{ratingDraft ? `${ratingDraft}/5` : 'Tap to rate'}</span>
          </div>
          {ratingDraft > 0 ? (
            <>
              <textarea
                className="portal-csat-comment field-input"
                placeholder="Anything else you want to tell us? (optional)"
                rows={2}
                value={ratingComment}
                onChange={(e) => setRatingComment(e.target.value)}
                maxLength={2000}
              />
              <button className="btn btn-primary btn-sm" disabled={ratingBusy} onClick={() => void submitRating()}>
                {ratingBusy ? 'Submitting…' : 'Submit rating'}
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {/* CSAT thanks state — after rating, include the comment inline */}
      {closed && csatRating ? (
        <div className="portal-csat-card portal-csat-done">
          <Icon name="star" size={16} />
          <strong>Thanks — you rated this request {csatRating.rating}/5.</strong>
          {csatRating.comment ? <p className="portal-csat-comment-done">“{csatRating.comment}”</p> : null}
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
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void sendReply()
            }
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
