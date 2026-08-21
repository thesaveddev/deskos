import { useEffect, useState, useRef, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, SubmitButton } from '../components/ui.js'
import { DirectoryPersonPicker } from '../components/DirectoryPersonPicker.js'
import type { DirectoryPerson } from '../lib/directory.js'
import { listDevices, type Device } from '../lib/devices.js'
import { createTicket, uploadAttachment } from '../lib/tickets.js'
import { getAccessToken } from '../lib/api.js'

export default function NewTicketPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Ticket fields
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('p3')
  const [type, setType] = useState('incident')
  const [deviceId, setDeviceId] = useState('')
  const [rootCause, setRootCause] = useState('')
  const [workaround, setWorkaround] = useState('')
  const [risk, setRisk] = useState<'low' | 'medium' | 'high'>('medium')
  const [implementationPlan, setImplementationPlan] = useState('')
  const [backoutPlan, setBackoutPlan] = useState('')
  const [scheduledAt, setScheduledAt] = useState('')

  // Requester details
  const [reqName, setReqName] = useState('')
  const [reqEmail, setReqEmail] = useState('')
  const [reqPhone, setReqPhone] = useState('')
  const [reqDept, setReqDept] = useState('')
  const [reqCompany, setReqCompany] = useState('')
  const [reqLocation, setReqLocation] = useState('')

  // File uploads
  const [files, setFiles] = useState<File[]>([])
  const [filePreviews, setFilePreviews] = useState<Array<{ name: string; size: string; type: string }>>([])

  const [devices, setDevices] = useState<Device[]>([])
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uploadProgress, setUploadProgress] = useState('')

  useEffect(() => {
    void listDevices()
      .then((response) => setDevices(response.devices))
      .catch((err) => setDeviceLoadError(err instanceof Error ? err.message : 'Device linking unavailable'))
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || [])
    setFiles((prev) => [...prev, ...selected])
    setFilePreviews((prev) => [
      ...prev,
      ...selected.map((f) => ({
        name: f.name,
        size: f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`,
        type: f.type || 'unknown',
      })),
    ])
  }

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
    setFilePreviews((prev) => prev.filter((_, i) => i !== index))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await createTicket({
        subject,
        description: description || undefined,
        priority,
        type,
        deviceId: deviceId || undefined,
        ...(type === 'problem' ? { rootCause: rootCause || undefined, workaround: workaround || undefined } : {}),
        ...(type === 'change'
          ? {
              risk,
              implementationPlan: implementationPlan || undefined,
              backoutPlan: backoutPlan || undefined,
              scheduledAt: scheduledAt || undefined,
            }
          : {}),
        // Requester details
        requesterName: reqName || undefined,
        requesterEmail: reqEmail || undefined,
        requesterPhone: reqPhone || undefined,
        requesterDepartment: reqDept || undefined,
        requesterCompany: reqCompany || undefined,
        requesterLocation: reqLocation || undefined,
      })

      // Upload attachments if any
      if (files.length > 0) {
        const token = getAccessToken()
        if (token) {
          for (let i = 0; i < files.length; i++) {
            setUploadProgress(`Uploading ${i + 1} of ${files.length}…`)
            try {
              await uploadAttachment(token, res.ticket.id, files[i])
            } catch {
              // Continue with other files even if one fails
            }
          }
        }
      }

      navigate(`/tickets/${res.ticket.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create ticket')
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">New ticket</h1>
      </div>
      <div className="form-panel">
        {error ? <Alert kind="error">{error}</Alert> : null}
        {uploadProgress && <Alert kind="info">{uploadProgress}</Alert>}
        <form onSubmit={submit}>
          {/* ── Requester details ── */}
          <div className="ticket-form-section">
            <h3 className="ticket-form-section-title">Requester details</h3>
            <p className="ticket-form-section-hint">Who is this ticket for? Leave blank if it's for yourself.</p>
            <DirectoryPersonPicker
              onSelect={(person: DirectoryPerson) => {
                setReqName(person.name)
                setReqEmail(person.email)
                setReqPhone(person.phone ?? '')
                setReqDept(person.department ?? '')
                setReqLocation(person.site ?? '')
              }}
            />
            <div className="form-row">
              <Field label="Name">
                <input className="field-input" value={reqName} onChange={(e) => setReqName(e.target.value)} placeholder="Full name" />
              </Field>
              <Field label="Email">
                <input className="field-input" type="email" value={reqEmail} onChange={(e) => setReqEmail(e.target.value)} placeholder="email@company.com" />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Phone">
                <input className="field-input" value={reqPhone} onChange={(e) => setReqPhone(e.target.value)} placeholder="+1 (555) 000-0000" />
              </Field>
              <Field label="Department">
                <input className="field-input" value={reqDept} onChange={(e) => setReqDept(e.target.value)} placeholder="e.g. Marketing, Finance" />
              </Field>
            </div>
            <div className="form-row">
              <Field label="Company">
                <input className="field-input" value={reqCompany} onChange={(e) => setReqCompany(e.target.value)} placeholder="Company name" />
              </Field>
              <Field label="Location">
                <input className="field-input" value={reqLocation} onChange={(e) => setReqLocation(e.target.value)} placeholder="e.g. Building A, Floor 3" />
              </Field>
            </div>
          </div>

          {/* ── Ticket details ── */}
          <div className="ticket-form-section">
            <h3 className="ticket-form-section-title">Issue details</h3>
            <p className="ticket-form-section-hint">This ticket will be assigned to you automatically after it is created.</p>
            <Field label="Subject">
              <input
                className="field-input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Brief summary of the issue"
                required
                autoFocus
              />
            </Field>
            <Field label="Description">
              <textarea
                className="composer-input"
                rows={6}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened, since when, what was tried…"
              />
            </Field>
            <div className="form-row">
              <Field label="Type">
                <select className="field-input" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="incident">Incident</option>
                  <option value="service_request">Service request</option>
                  <option value="question">Question</option>
                  <option value="problem">Problem</option>
                  <option value="change">Change</option>
                </select>
              </Field>
              <Field label="Priority" hint="Drives SLA deadlines.">
                <select className="field-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="p1">P1 — Critical</option>
                  <option value="p2">P2 — High</option>
                  <option value="p3">P3 — Normal</option>
                  <option value="p4">P4 — Low</option>
                </select>
              </Field>
            </div>
            <Field label="Affected device" hint={deviceLoadError ?? 'Optional — links the ticket to endpoint health and alerts.'}>
              <select className="field-input" value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={Boolean(deviceLoadError)}>
                <option value="">No device linked</option>
                {devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.hostname ? ` · ${device.hostname}` : ''}</option>)}
              </select>
            </Field>
          </div>

          {/* ── Problem/Change fields ── */}
          {type === 'problem' && (
            <div className="ticket-form-section">
              <h3 className="ticket-form-section-title">Problem details</h3>
              <Field label="Root cause">
                <textarea className="composer-input" rows={3} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
              </Field>
              <Field label="Workaround">
                <textarea className="composer-input" rows={3} value={workaround} onChange={(e) => setWorkaround(e.target.value)} />
              </Field>
            </div>
          )}

          {type === 'change' && (
            <div className="ticket-form-section">
              <h3 className="ticket-form-section-title">Change details</h3>
              <div className="form-row">
                <Field label="Risk">
                  <select className="field-input" value={risk} onChange={(e) => setRisk(e.target.value as 'low' | 'medium' | 'high')}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </Field>
                <Field label="Scheduled for" hint="ISO datetime">
                  <input className="field-input mono" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} placeholder="2026-08-20T09:00:00Z" />
                </Field>
              </div>
              <Field label="Implementation plan">
                <textarea className="composer-input" rows={3} value={implementationPlan} onChange={(e) => setImplementationPlan(e.target.value)} />
              </Field>
              <Field label="Backout plan">
                <textarea className="composer-input" rows={3} value={backoutPlan} onChange={(e) => setBackoutPlan(e.target.value)} />
              </Field>
            </div>
          )}

          {/* ── File attachments ── */}
          <div className="ticket-form-section">
            <h3 className="ticket-form-section-title">Attachments</h3>
            <p className="ticket-form-section-hint">Screenshots, logs, or any files that help explain the issue.</p>
            <div
              className="ticket-upload-zone"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over') }}
              onDragLeave={(e) => e.currentTarget.classList.remove('drag-over')}
              onDrop={(e) => {
                e.preventDefault()
                e.currentTarget.classList.remove('drag-over')
                const dropped = Array.from(e.dataTransfer.files)
                setFiles((prev) => [...prev, ...dropped])
                setFilePreviews((prev) => [
                  ...prev,
                  ...dropped.map((f) => ({
                    name: f.name,
                    size: f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`,
                    type: f.type || 'unknown',
                  })),
                ])
              }}
            >
              <span className="ticket-upload-icon">📎</span>
              <span className="ticket-upload-text">Click to browse or drag files here</span>
              <span className="ticket-upload-hint">Max 25 MB per file</span>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              style={{ display: 'none' }}
              accept="*/*"
            />
            {filePreviews.length > 0 && (
              <div className="ticket-file-list">
                {filePreviews.map((f, i) => (
                  <div key={i} className="ticket-file-row">
                    <span className="ticket-file-icon">📄</span>
                    <div className="ticket-file-info">
                      <span className="ticket-file-name">{f.name}</span>
                      <span className="ticket-file-meta">{f.size}</span>
                    </div>
                    <button type="button" className="btn btn-ghost btn-xs" onClick={() => removeFile(i)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <SubmitButton busy={busy}>{busy && uploadProgress ? 'Creating & uploading…' : 'Create ticket'}</SubmitButton>
        </form>
      </div>
    </Shell>
  )
}
