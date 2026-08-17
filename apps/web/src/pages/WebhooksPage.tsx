import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, Panel } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  testWebhook,
  type WebhookChannel,
  type WebhookDelivery,
  type WebhookEndpoint,
} from '../lib/webhooks.js'

const CHANNELS: WebhookChannel[] = ['generic', 'slack', 'teams']
const EVENT_PRESETS = ['ticket.*', 'session.*', 'device.*', 'sla.*']

interface FormState {
  name: string
  url: string
  secret: string
  channel: WebhookChannel
  events: string
}

const EMPTY_FORM: FormState = { name: '', url: '', secret: '', channel: 'slack', events: 'ticket.*' }

export default function WebhooksPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canManage = perms.has('integration.manage')

  const [endpoints, setEndpoints] = useState<WebhookEndpoint[] | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [modalOpen, setModalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deliveriesId, setDeliveriesId] = useState<string | null>(null)
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setEndpoints((await listWebhooks()).endpoints)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load webhooks')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await createWebhook({
        name: form.name,
        url: form.url,
        secret: form.secret || undefined,
        channel: form.channel,
        events: form.events.split(',').map((s) => s.trim()).filter(Boolean),
      })
      setForm(EMPTY_FORM)
      setModalOpen(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create webhook')
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (id: string) => {
    setBusy(true)
    setTestResult(null)
    setError(null)
    try {
      const result = await testWebhook(id)
      setTestResult(`${result.status} (attempt ${result.attempts})${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await deleteWebhook(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete webhook')
    } finally {
      setBusy(false)
    }
  }

  const showDeliveries = async (id: string) => {
    setDeliveriesId(id)
    try {
      setDeliveries((await listWebhookDeliveries(id)).deliveries)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load deliveries')
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Integrations"
        subtitle="Outbound webhooks for Slack, Teams, and generic endpoints."
        actions={canManage ? <button className="btn btn-primary btn-sm" onClick={() => { setForm(EMPTY_FORM); setError(null); setModalOpen(true) }}>New webhook</button> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {testResult ? <Alert kind="info">Test delivery: {testResult}</Alert> : null}

      <Panel title="Endpoints" empty={endpoints !== null && endpoints.length === 0}>
        {endpoints === null ? (
          <div className="etch" style={{ padding: 24 }}>Loading webhooks…</div>
        ) : (
          <ul className="channel-list">
            {endpoints.map((e) => (
              <li key={e.id} className="channel-card">
                <div className="channel-main">
                  <span className="channel-name">{e.name}</span>
                  <span className="channel-meta mono">{e.channel} · {e.events.join(', ')} · {e.enabled ? 'enabled' : 'disabled'}</span>
                </div>
                <div className="channel-actions">
                  {canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void runTest(e.id)}>Test</button> : null}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void showDeliveries(e.id)}>Deliveries</button>
                  {canManage ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void remove(e.id)}>Delete</button> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {deliveriesId ? (
        <>
          <div style={{ height: 16 }} />
          <Panel
            title="Recent deliveries"
            actions={<button className="btn btn-ghost btn-sm" onClick={() => { setDeliveriesId(null); setDeliveries(null) }}>Close</button>}
            empty={deliveries !== null && deliveries.length === 0}
          >
            {deliveries === null ? (
              <div className="etch" style={{ padding: 24 }}>Loading…</div>
            ) : (
              <ul className="channel-list">
                {deliveries.map((d) => (
                  <li key={d.id} className="channel-card">
                    <div className="channel-main">
                      <span className="channel-name mono">{d.event}</span>
                      <span className="channel-meta mono">{d.status} · {d.attempts} attempt(s){d.last_error ? ` · ${d.last_error}` : ''}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      ) : null}

      <Modal
        open={modalOpen}
        onClose={() => { if (!busy) setModalOpen(false) }}
        title="New webhook"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button>
            <button type="submit" form="webhook-form" className="btn btn-primary" disabled={busy || !form.name.trim() || !form.url.trim()}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </>
        }
      >
        <form id="webhook-form" onSubmit={(e) => void submit(e)}>
          <div className="form-row">
            <Field label="Name">
              <input className="field-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
            </Field>
            <Field label="Channel">
              <select className="field-input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value as WebhookChannel })}>
                {CHANNELS.map((c) => <option key={c} value={c}>{c === 'teams' ? 'Microsoft Teams' : c === 'slack' ? 'Slack' : 'Generic'}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Webhook URL">
            <input className="field-input mono" placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required />
          </Field>
          <Field label="Secret" hint="optional — HMAC-signs payloads">
            <input className="field-input mono" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
          </Field>
          <Field label="Events" hint="comma-separated prefixes">
            <input className="field-input mono" placeholder="ticket.*, session.*" value={form.events} onChange={(e) => setForm({ ...form, events: e.target.value })} />
          </Field>
          <div className="toolbar" style={{ marginTop: 4 }}>
            {EVENT_PRESETS.map((p) => (
              <button key={p} type="button" className="btn btn-ghost btn-sm" onClick={() => setForm({ ...form, events: p })}>{p}</button>
            ))}
          </div>
        </form>
      </Modal>
    </Shell>
  )
}
