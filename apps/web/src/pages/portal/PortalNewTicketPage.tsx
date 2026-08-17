import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
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
      <div className="page-head">
        <h1 className="page-title">New request</h1>
      </div>
      {error ? <Alert kind="error">{error}</Alert> : null}
      <form className="form-panel" onSubmit={handleSubmit}>
        <Field label="Subject" hint="A short summary of what you need help with">
          <input
            className="field-input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            minLength={3}
            maxLength={300}
            required
            autoFocus
          />
        </Field>
        <Field label="Description" hint="The more detail you give, the faster we can help">
          <textarea
            className="field-input"
            rows={8}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={20000}
          />
        </Field>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || subject.trim().length < 3}>
            {busy ? 'Submitting…' : 'Submit request'}
          </button>
        </div>
      </form>
    </PortalShell>
  )
}
