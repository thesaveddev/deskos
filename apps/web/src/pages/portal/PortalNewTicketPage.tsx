import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PortalShell } from '../../components/PortalShell.js'
import { Icon } from '../../components/Icons.js'
import { Alert, Field } from '../../components/ui.js'
import { createPortalTicket, uploadPortalAttachment } from '../../lib/portal.js'

export default function PortalNewTicketPage() {
  const navigate = useNavigate()
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = (incoming: FileList | File[]) => {
    setFiles((prev) => [...prev, ...Array.from(incoming)])
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { ticket } = await createPortalTicket({ subject: subject.trim(), description: description.trim() || undefined })
      // Upload any attached files
      for (const file of files) {
        try {
          await uploadPortalAttachment(ticket.number, file)
        } catch {
          // Non-fatal — the ticket was created; file upload failure is noted
        }
      }
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

          {/* File upload */}
          <div style={{ marginTop: 4 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-2)', marginBottom: 6 }}>
              Attachments
            </label>
            <div
              className="portal-attach-dropzone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
              onDrop={(e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files) }}
            >
              <Icon name="paperclip" size={18} />
              <span>Drop files here or <strong>browse</strong></span>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Max 25 MB per file</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }}
            />

            {files.length > 0 ? (
              <div className="portal-attach-list">
                {files.map((f, i) => (
                  <div key={`${f.name}-${i}`} className="portal-attach-item">
                    <Icon name="paperclip" size={14} />
                    <span className="portal-attach-name">{f.name}</span>
                    <span className="portal-attach-size">{formatSize(f.size)}</span>
                    <button type="button" className="portal-attach-remove" onClick={() => removeFile(i)} aria-label="Remove file">
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="form-actions" style={{ marginTop: 16 }}>
            <button type="submit" className="btn btn-primary" disabled={busy || subject.trim().length < 3}>
              {busy ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </PortalShell>
  )
}
