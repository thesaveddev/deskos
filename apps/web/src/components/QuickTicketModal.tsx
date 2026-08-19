import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, Field, Modal } from './ui.js'
import { Icon } from './Icons.js'
import { createTicket, uploadAttachment } from '../lib/tickets.js'
import { getAccessToken } from '../lib/api.js'

export function QuickTicketModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('p3')
  const [type, setType] = useState('incident')
  const [requesterName, setRequesterName] = useState('')
  const [requesterEmail, setRequesterEmail] = useState('')
  const [requesterPhone, setRequesterPhone] = useState('')
  const [requesterDepartment, setRequesterDepartment] = useState('')
  const [requesterCompany, setRequesterCompany] = useState('')
  const [requesterLocation, setRequesterLocation] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setSubject('')
    setDescription('')
    setPriority('p3')
    setType('incident')
    setRequesterName('')
    setRequesterEmail('')
    setRequesterPhone('')
    setRequesterDepartment('')
    setRequesterCompany('')
    setRequesterLocation('')
    setFiles([])
    setUploadProgress('')
    setError(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    setFiles((current) => [...current, ...selected])
    event.target.value = ''
  }

  const removeFile = (index: number) => {
    setFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!subject.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await createTicket({
        subject: subject.trim(),
        description: description.trim() || undefined,
        priority,
        type,
        requesterName: requesterName.trim() || undefined,
        requesterEmail: requesterEmail.trim() || undefined,
        requesterPhone: requesterPhone.trim() || undefined,
        requesterDepartment: requesterDepartment.trim() || undefined,
        requesterCompany: requesterCompany.trim() || undefined,
        requesterLocation: requesterLocation.trim() || undefined,
      })

      if (files.length > 0) {
        const token = getAccessToken()
        if (!token) throw new Error('The ticket was created, but your session expired before files could be uploaded.')
        const failedFiles: string[] = []
        for (let index = 0; index < files.length; index += 1) {
          setUploadProgress(`Uploading ${index + 1} of ${files.length}…`)
          try {
            await uploadAttachment(token, result.ticket.id, files[index])
          } catch {
            failedFiles.push(files[index].name)
          }
        }
        if (failedFiles.length > 0) {
          throw new Error(`Ticket #${result.ticket.number} was created, but these files could not be uploaded: ${failedFiles.join(', ')}.`)
        }
      }

      reset()
      onClose()
      navigate(`/tickets/${result.ticket.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create ticket')
    } finally {
      setBusy(false)
      setUploadProgress('')
    }
  }

  return (
    <Modal open={open} onClose={() => { if (!busy) { reset(); onClose() } }} title="Create a ticket" width={760}>
      <form onSubmit={submit}>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {uploadProgress ? <Alert kind="info">{uploadProgress}</Alert> : null}

        <section className="ticket-form-section">
          <h3 className="ticket-form-section-title">Requester details</h3>
          <p className="ticket-form-section-hint">Capture who needs help. Leave these fields blank when you are raising the ticket for yourself.</p>
          <div className="form-row">
            <Field label="Name"><input className="field-input" value={requesterName} onChange={(event) => setRequesterName(event.target.value)} placeholder="Full name" /></Field>
            <Field label="Email"><input className="field-input" type="email" value={requesterEmail} onChange={(event) => setRequesterEmail(event.target.value)} placeholder="email@company.com" /></Field>
          </div>
          <div className="form-row">
            <Field label="Phone"><input className="field-input" value={requesterPhone} onChange={(event) => setRequesterPhone(event.target.value)} placeholder="Phone number" /></Field>
            <Field label="Department"><input className="field-input" value={requesterDepartment} onChange={(event) => setRequesterDepartment(event.target.value)} placeholder="Finance, HR, IT…" /></Field>
          </div>
          <div className="form-row">
            <Field label="Company"><input className="field-input" value={requesterCompany} onChange={(event) => setRequesterCompany(event.target.value)} placeholder="Company name" /></Field>
            <Field label="Location"><input className="field-input" value={requesterLocation} onChange={(event) => setRequesterLocation(event.target.value)} placeholder="Building, floor, or site" /></Field>
          </div>
        </section>

        <section className="ticket-form-section">
          <h3 className="ticket-form-section-title">Issue details</h3>
          <p className="ticket-form-section-hint">This staff-created ticket will be assigned to you automatically.</p>
          <div className="form-row">
            <Field label="Subject"><input className="field-input" autoFocus required value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="What do you need help with?" /></Field>
            <Field label="Priority"><select className="field-input" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="p1">P1 — Critical</option><option value="p2">P2 — High</option><option value="p3">P3 — Normal</option><option value="p4">P4 — Low</option></select></Field>
          </div>
          <Field label="Type"><select className="field-input" value={type} onChange={(event) => setType(event.target.value)}><option value="incident">Incident</option><option value="service_request">Service request</option><option value="question">Question</option><option value="problem">Problem</option><option value="change">Change</option></select></Field>
          <Field label="Details"><textarea className="field-input" rows={5} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what happened, who is affected, and what you have tried…" /></Field>
        </section>

        <section className="ticket-form-section">
          <div className="ticket-form-section-heading-row"><div><h3 className="ticket-form-section-title">Attachments</h3><p className="ticket-form-section-hint">Add screenshots, logs, or other files. Maximum 25 MB per file.</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} disabled={busy}><Icon name="upload" size={14} />Add files</button></div>
          <input ref={fileInputRef} type="file" multiple hidden onChange={addFiles} />
          {files.length > 0 ? <div className="ticket-file-list">{files.map((file, index) => <div className="ticket-file-row" key={`${file.name}-${index}`}><Icon name="file" size={15} /><div className="ticket-file-info"><span className="ticket-file-name">{file.name}</span><span className="ticket-file-meta">{(file.size / 1024 / 1024).toFixed(2)} MB</span></div><button type="button" className="btn btn-ghost btn-xs" onClick={() => removeFile(index)} disabled={busy} aria-label={`Remove ${file.name}`}><Icon name="delete" size={14} /></button></div>)}</div> : <button type="button" className="ticket-upload-zone" onClick={() => fileInputRef.current?.click()} disabled={busy}><Icon name="upload" size={20} /><span><strong>Choose files to attach</strong><small>Images, logs, documents, and other helpful evidence</small></span></button>}
        </section>

        <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { reset(); onClose() }} disabled={busy}><Icon name="close" size={14} />Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !subject.trim()}><Icon name="ticket" size={14} />{busy ? uploadProgress ? 'Creating & uploading…' : 'Creating…' : 'Create ticket'}</button></div>
      </form>
    </Modal>
  )
}
