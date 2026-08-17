import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, SubmitButton } from '../components/ui.js'
import { listDevices, type Device } from '../lib/devices.js'
import { createTicket } from '../lib/tickets.js'

export default function NewTicketPage() {
  const navigate = useNavigate()
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
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void listDevices()
      .then((response) => setDevices(response.devices))
      .catch((err) => setDeviceLoadError(err instanceof Error ? err.message : 'Device linking unavailable'))
  }, [])

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
      })
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
        <form onSubmit={submit}>
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

          {type === 'problem' ? (
            <>
              <Field label="Root cause">
                <textarea className="composer-input" rows={3} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
              </Field>
              <Field label="Workaround">
                <textarea className="composer-input" rows={3} value={workaround} onChange={(e) => setWorkaround(e.target.value)} />
              </Field>
            </>
          ) : null}

          {type === 'change' ? (
            <>
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
            </>
          ) : null}

          <SubmitButton busy={busy}>Create ticket</SubmitButton>
        </form>
      </div>
    </Shell>
  )
}
