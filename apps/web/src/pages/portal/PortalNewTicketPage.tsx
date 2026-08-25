import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert, Field } from '../../components/ui.js'
import { createPortalTicket } from '../../lib/portal.js'

export default function PortalNewTicketPage() {
  const navigate = useNavigate()
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { ticket } = await createPortalTicket({ subject: subject.trim(), description: description.trim() || undefined })
      navigate(`/portal/tickets/${ticket.number}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed')
      setBusy(false)
    }
  }

  return (
    <PortalShell>
      <div style={{ maxWidth: 680 }}>
        <div className="portal-queue-header">
          <h2>New request</h2>
        </div>

        {error ? <Alert kind="error">{error}</Alert> : null}

        <div className="portal-new-help">
          <Icon name="sparkles" size={16} />
          <span>
            Describe your issue in detail. The more information you provide — including error messages, steps to reproduce, and affected devices — the faster our team can help.
          </span>
        </div>

        <form className="portal-new-form" onSubmit={handleSubmit} style={{ marginTop: 18 }}>
          <Field label="Subject" hint="A short summary of what you need help with">
            <input
              className="field-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. Printer not responding on 3rd floor"
              minLength={3}
              maxLength={300}
              required
              autoFocus
            />
          </Field>

          <Field label="Description" hint="Include steps to reproduce, error messages, and any relevant details">
            <textarea
              className="field-input"
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened? What did you expect? What have you already tried?"
              maxLength={20000}
            />
          </Field>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={busy || subject.trim().length < 3}>
              {busy ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </PortalShell>
  )
}
