import { useCallback, useEffect, useState, type FormEvent } from 'react'
import LandingLayout from '../components/LandingLayout'
import { api } from '../lib/api.js'

interface SupportTicket {
  id: number
  number: number
  subject: string
  description: string | null
  category: string
  priority: string
  status: string
  created_at: string
  updated_at: string
}

interface SupportThread {
  id: number
  kind: string
  body: string
  author_name: string
  created_at: string
}

const CATEGORIES = [
  { value: 'general', label: 'General question' },
  { value: 'bug', label: 'Bug report' },
  { value: 'feature_request', label: 'Feature request' },
  { value: 'billing', label: 'Billing' },
  { value: 'security', label: 'Security concern' },
  { value: 'other', label: 'Other' },
]

const PRIORITY_LABELS: Record<string, string> = {
  p1: 'Critical — system down',
  p2: 'High — major feature broken',
  p3: 'Medium — normal issue',
  p4: 'Low — minor / cosmetic',
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  open: { label: 'Open', color: 'var(--info)' },
  in_progress: { label: 'In progress', color: 'var(--accent)' },
  waiting_user: { label: 'Waiting on you', color: 'var(--warn)' },
  resolved: { label: 'Resolved', color: 'var(--ok)' },
  closed: { label: 'Closed', color: 'var(--text-3)' },
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([])
  const [selected, setSelected] = useState<SupportTicket | null>(null)
  const [threads, setThreads] = useState<SupportThread[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [replyBody, setReplyBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // form state
  const [form, setForm] = useState({ subject: '', description: '', category: 'general', priority: 'p3' })

  const loadTickets = useCallback(async () => {
    try {
      const res = await api('/support/tickets') as { tickets: SupportTicket[] }
      setTickets(res.tickets)
    } catch { /* user might not be logged in */ }
    setLoading(false)
  }, [])

  useEffect(() => { void loadTickets() }, [loadTickets])

  const loadTicket = async (ticket: SupportTicket) => {
    setSelected(ticket)
    try {
      const res = await api(`/support/tickets/${ticket.id}`) as { threads: SupportThread[] }
      setThreads(res.threads)
    } catch { setThreads([]) }
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await api('/support/tickets', { method: 'POST', body: form }) as { ticket: SupportTicket }
      setTickets((prev) => [res.ticket, ...prev])
      setShowForm(false)
      setForm({ subject: '', description: '', category: 'general', priority: 'p3' })
      void loadTicket(res.ticket)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit ticket')
    }
    setSubmitting(false)
  }

  const handleReply = async () => {
    if (!selected || !replyBody.trim()) return
    try {
      const res = await api(`/support/tickets/${selected.id}/reply`, {
        method: 'POST',
        body: { body: replyBody },
      }) as { thread: SupportThread }
      setThreads((prev) => [...prev, res.thread])
      setReplyBody('')
      void loadTickets()
    } catch { /* silent */ }
  }

  return (
    <LandingLayout
      title="Support — DeskOS"
      description="Get help with DeskOS. Submit bug reports, feature requests, and technical support tickets."
    >
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Support</span>
          <h1 className="landing-title">Need help with DeskOS?</h1>
          <p className="landing-sub">
            Submit a ticket for any issue with DeskOS — bugs, feature requests, billing, or technical support. Our team typically responds within 24 hours.
          </p>
        </div>
      </section>

      <section className="landing-section" style={{ paddingTop: 0 }}>
        <div className="support-container">
          {error && <div className="alert alert-error">{error}</div>}

          {/* Action bar */}
          <div className="support-actions">
            <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setSelected(null) }}>
              {showForm ? 'Cancel' : '+ New ticket'}
            </button>
          </div>

          {/* New ticket form */}
          {showForm && (
            <div className="support-form-panel">
              <h3>Submit a support ticket</h3>
              <form onSubmit={handleSubmit}>
                <div className="field">
                  <label className="field-label" htmlFor="sup-subject">Subject</label>
                  <input className="field-input" id="sup-subject" required minLength={3} maxLength={300}
                    value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
                </div>
                <div className="form-row">
                  <div className="field">
                    <label className="field-label" htmlFor="sup-category">Category</label>
                    <select className="field-input" id="sup-category"
                      value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                      {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label" htmlFor="sup-priority">Priority</label>
                    <select className="field-input" id="sup-priority"
                      value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value }))}>
                      {Object.entries(PRIORITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  </div>
                </div>
                <div className="field">
                  <label className="field-label" htmlFor="sup-desc">Description</label>
                  <textarea className="field-input" id="sup-desc" rows={5}
                    value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                </div>
                <button className="btn btn-primary" type="submit" disabled={submitting}>
                  {submitting ? 'Submitting…' : 'Submit ticket'}
                </button>
              </form>
            </div>
          )}

          {/* Ticket list / detail */}
          <div className="support-layout">
            <div className="support-ticket-list">
              <h3>Your tickets</h3>
              {loading ? (
                <span className="etch">Loading…</span>
              ) : tickets.length === 0 ? (
                <div className="empty-state">
                  <p>No tickets yet. Click "New ticket" to submit one.</p>
                </div>
              ) : (
                tickets.map((t) => {
                  const st = STATUS_LABELS[t.status] || STATUS_LABELS.open
                  return (
                    <button key={t.id} className={`support-ticket-item${selected?.id === t.id ? ' active' : ''}`}
                      onClick={() => void loadTicket(t)}>
                      <div className="support-ticket-item-top">
                        <span className="mono" style={{ color: 'var(--text-3)' }}>#{t.number}</span>
                        <span className="support-status-dot" style={{ background: st.color }} />
                      </div>
                      <div className="support-ticket-item-subject">{t.subject}</div>
                      <div className="support-ticket-item-meta">
                        <span style={{ color: st.color }}>{st.label}</span>
                        <span className="muted">{formatDate(t.updated_at)}</span>
                      </div>
                    </button>
                  )
                })
              )}
            </div>

            <div className="support-ticket-detail">
              {selected ? (
                <>
                  <div className="support-detail-header">
                    <h3>#{selected.number} — {selected.subject}</h3>
                    <div className="support-detail-meta">
                      <span className="support-category-badge">{selected.category.replace('_', ' ')}</span>
                      <span className="support-priority-badge">{selected.priority}</span>
                    </div>
                  </div>
                  <div className="support-threads">
                    {threads.map((th) => (
                      <div key={th.id} className={`support-thread ${th.kind}`}>
                        <div className="support-thread-head">
                          <strong>{th.author_name}</strong>
                          <span className="muted">{formatDate(th.created_at)}</span>
                        </div>
                        <p>{th.body}</p>
                      </div>
                    ))}
                  </div>
                  {selected.status !== 'resolved' && selected.status !== 'closed' && (
                    <div className="support-reply-box">
                      <textarea className="field-input" rows={3} placeholder="Type your reply…"
                        value={replyBody} onChange={(e) => setReplyBody(e.target.value)} />
                      <button className="btn btn-primary btn-sm" onClick={() => void handleReply()}
                        disabled={!replyBody.trim()}>Reply</button>
                    </div>
                  )}
                </>
              ) : (
                <div className="empty-state">
                  <p>Select a ticket to view its details.</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>
    </LandingLayout>
  )
}
