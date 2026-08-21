import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, Panel, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import {
  clickToCall, createTelephonyIntegration, deleteTelephonyIntegration, listCalls, listTelephonyIntegrations, logCall,
  type CallDirection, type CallLog, type CallStatus, type TelephonyIntegration,
} from '../lib/telephony.js'

const DIRECTIONS: CallDirection[] = ['inbound', 'outbound', 'internal']
const STATUSES: CallStatus[] = ['ringing', 'answered', 'missed', 'completed', 'failed']

function formatDuration(sec: number): string {
  if (sec <= 0) return '—'
  const m = Math.floor(sec / 60); const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

interface CallForm { direction: CallDirection; fromNumber: string; toNumber: string; callerName: string; status: CallStatus; durationSec: string; ticketId: string }
interface IntegrationForm { name: string; provider: 'generic' | 'twilio'; clickToCallUrl: string; providerSecret: string; accountSid: string; fromNumber: string; twimlUrl: string; webhookUrl: string; autoMatch: boolean }
const EMPTY_FORM: CallForm = { direction: 'inbound', fromNumber: '', toNumber: '', callerName: '', status: 'completed', durationSec: '', ticketId: '' }
const EMPTY_INTEGRATION: IntegrationForm = { name: '', provider: 'generic', clickToCallUrl: '', providerSecret: '', accountSid: '', fromNumber: '', twimlUrl: '', webhookUrl: '', autoMatch: true }

export default function CallsPage() {
  const canManage = useAuth((state) => state.memberships.some((membership) => membership.permissions.includes('telephony.manage')))
  const confirm = useConfirm()
  const [calls, setCalls] = useState<CallLog[] | null>(null)
  const [integrations, setIntegrations] = useState<TelephonyIntegration[]>([])
  const [q, setQ] = useState('')
  const [direction, setDirection] = useState<CallDirection | ''>('')
  const [status, setStatus] = useState<CallStatus | ''>('')
  const [phone, setPhone] = useState('')
  const [form, setForm] = useState<CallForm>(EMPTY_FORM)
  const [integrationForm, setIntegrationForm] = useState<IntegrationForm>(EMPTY_INTEGRATION)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [logModal, setLogModal] = useState(false)
  const [integrationModal, setIntegrationModal] = useState(false)
  const [newWebhook, setNewWebhook] = useState<{ token: string; path: string; callbackUrl?: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const callsResult = await listCalls({ q: q || undefined, direction: direction || undefined, status: status || undefined })
      setCalls(callsResult.calls)
      if (canManage) setIntegrations((await listTelephonyIntegrations()).integrations)
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load calls') }
  }, [q, direction, status, canManage])

  useEffect(() => { const timer = setTimeout(() => void load(), 250); return () => clearTimeout(timer) }, [load])

  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(null)
    try {
      await logCall({ direction: form.direction, fromNumber: form.fromNumber || undefined, toNumber: form.toNumber || undefined, callerName: form.callerName || undefined, status: form.status, durationSec: form.durationSec ? Number(form.durationSec) : undefined, ticketId: form.ticketId || undefined })
      setForm(EMPTY_FORM); setLogModal(false); setNotice('Call activity added to the log and linked ticket timeline where applicable.'); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not log call') }
    finally { setBusy(false) }
  }

  const dial = async (number: string, ticketId?: string | null) => {
    if (!number) return
    setError(null)
    try {
      const result = canManage ? await clickToCall({ toNumber: number, ticketId: ticketId ?? null }) : { dialUri: `tel:${number}` }
      window.location.assign(result.dialUri)
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start the call') }
  }

  const createIntegration = async (event: FormEvent) => {
    event.preventDefault(); if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      const result = await createTelephonyIntegration({
        name: integrationForm.name,
        provider: integrationForm.provider,
        clickToCallUrl: integrationForm.provider === 'generic' && integrationForm.clickToCallUrl ? integrationForm.clickToCallUrl : undefined,
        providerSecret: integrationForm.providerSecret || undefined,
        providerConfig: integrationForm.provider === 'twilio' ? { accountSid: integrationForm.accountSid, fromNumber: integrationForm.fromNumber, twimlUrl: integrationForm.twimlUrl, webhookUrl: integrationForm.webhookUrl || undefined } : undefined,
        autoMatch: integrationForm.autoMatch,
      })
      setNewWebhook({ token: result.webhookToken, path: result.integration.webhook_path, callbackUrl: result.integration.provider_config?.webhookUrl }); setIntegrationForm(EMPTY_INTEGRATION); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not create telephony integration') }
    finally { setBusy(false) }
  }

  const removeIntegration = async (integration: TelephonyIntegration) => {
    if (!await confirm(`Delete “${integration.name}”? Providers will no longer be able to send inbound events.`, { title: 'Delete telephony integration', confirmLabel: 'Delete integration', destructive: true })) return
    try { await deleteTelephonyIntegration(integration.id); setNotice('Telephony integration deleted.'); await load() } catch (err) { setError(err instanceof Error ? err.message : 'Could not delete integration') }
  }

  const copy = async (value: string) => { await navigator.clipboard?.writeText(value); setNotice('Copied to clipboard.') }

  return <Shell>
    <div className="page-head"><div><h1 className="page-title">Calls</h1><p className="page-subtitle">Click-to-call, inbound call activity, and ticket context in one timeline.</p></div><div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><button className="btn btn-primary btn-sm" onClick={() => setLogModal(true)}><Icon name="add" size={14} />Log call</button>{canManage ? <button className="btn btn-ghost btn-sm" onClick={() => { setNewWebhook(null); setIntegrationModal(true) }}><Icon name="settings" size={14} />Connect provider</button> : null}</div></div>
    {error ? <Alert kind="error">{error}</Alert> : null}{notice ? <Alert kind="info">{notice}</Alert> : null}

    {canManage ? <Panel title="Inbound call integrations" subtitle="Give your PBX or provider the webhook path and one-time token. Unknown or ambiguous callers are never attached automatically.">
      {integrations.length === 0 ? <p className="muted">No provider connected. Browser click-to-call still works using the device’s default dialler.</p> : <div className="channel-list">{integrations.map((integration) => <div className="channel-card" key={integration.id}><div className="channel-main"><span className="channel-name">{integration.name} <span className="badge">{integration.provider}</span></span><span className="channel-meta mono">POST {integration.webhook_path} · automatic matching {integration.auto_match ? 'on' : 'off'}</span><span className="channel-meta">{integration.click_to_call_url ? 'Provider dispatch configured' : 'Browser dialler mode'} · {integration.enabled ? 'enabled' : 'disabled'}</span></div><button className="btn btn-ghost btn-sm" onClick={() => void removeIntegration(integration)}><Icon name="delete" size={14} />Remove</button></div>)}</div>}
    </Panel> : null}

    <Modal open={integrationModal} onClose={() => { if (!busy) setIntegrationModal(false) }} title="Connect telephony provider">
      {newWebhook ? <div><Alert kind="info">Save this token now. It will not be shown again.</Alert><Field label="Webhook path"><div className="copy-field"><input className="field-input mono" readOnly value={newWebhook.path} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(newWebhook.path)}><Icon name="copy" size={14} /></button></div></Field><Field label="Webhook token"><div className="copy-field"><input className="field-input mono" readOnly value={newWebhook.token} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(newWebhook.token)}><Icon name="copy" size={14} /></button></div></Field>{newWebhook.callbackUrl ? <Field label="Twilio status callback URL"><div className="copy-field"><input className="field-input mono" readOnly value={newWebhook.callbackUrl} /><button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(newWebhook.callbackUrl ?? '')}><Icon name="copy" size={14} /></button></div></Field> : null}<p className="field-hint">Generic providers send the token in the <code>x-deskos-telephony-token</code> header. Twilio uses its signed <code>X-Twilio-Signature</code> callback and does not need the ReyDesk token.</p><div className="modal-foot"><button className="btn btn-primary" onClick={() => setIntegrationModal(false)}>Done</button></div></div> : <form onSubmit={(event) => void createIntegration(event)}><Field label="Integration name"><input className="field-input" value={integrationForm.name} onChange={(event) => setIntegrationForm({ ...integrationForm, name: event.target.value })} placeholder="Main PBX" required /></Field><div className="form-row"><Field label="Provider"><select className="field-input" value={integrationForm.provider} onChange={(event) => setIntegrationForm({ ...integrationForm, provider: event.target.value as IntegrationForm['provider'] })}><option value="twilio">Twilio</option><option value="generic">Generic provider</option></select></Field>{integrationForm.provider === 'generic' ? <Field label="Click-to-call dispatch URL" hint="Optional provider endpoint; browser tel: dialing works without it."><input className="field-input" type="url" value={integrationForm.clickToCallUrl} onChange={(event) => setIntegrationForm({ ...integrationForm, clickToCallUrl: event.target.value })} placeholder="https://provider.example/calls" /></Field> : <Field label="Twilio Account SID"><input className="field-input mono" value={integrationForm.accountSid} onChange={(event) => setIntegrationForm({ ...integrationForm, accountSid: event.target.value })} placeholder="AC…" required /></Field>}</div>{integrationForm.provider === 'twilio' ? <><div className="form-row"><Field label="Twilio caller ID" hint="A Twilio-owned E.164 number."><input className="field-input mono" value={integrationForm.fromNumber} onChange={(event) => setIntegrationForm({ ...integrationForm, fromNumber: event.target.value })} placeholder="+15551234567" required /></Field><Field label="TwiML URL" hint="Public TwiML endpoint that controls the call."><input className="field-input" type="url" value={integrationForm.twimlUrl} onChange={(event) => setIntegrationForm({ ...integrationForm, twimlUrl: event.target.value })} placeholder="https://example.com/twiml" required /></Field></div><Field label="Status callback URL" hint="Use the generated webhook path with your public API origin. Leave blank only when your provider rewrites it."><input className="field-input" type="url" value={integrationForm.webhookUrl} onChange={(event) => setIntegrationForm({ ...integrationForm, webhookUrl: event.target.value })} placeholder="https://api.example.com/api/v1/telephony/webhooks/…" /></Field></> : null}<Field label={integrationForm.provider === 'twilio' ? 'Twilio Auth Token' : 'Provider secret'} hint="Encrypted at rest and never returned."><input className="field-input" type="password" value={integrationForm.providerSecret} onChange={(event) => setIntegrationForm({ ...integrationForm, providerSecret: event.target.value })} required={integrationForm.provider === 'twilio'} /></Field><label className="checkbox-field"><input type="checkbox" checked={integrationForm.autoMatch} onChange={(event) => setIntegrationForm({ ...integrationForm, autoMatch: event.target.checked })} /><span className="field-label">Automatically match inbound numbers to one open ticket</span></label><div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setIntegrationModal(false)} disabled={busy}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create integration'}</button></div></form>}
    </Modal>

    <Modal open={logModal} onClose={() => { if (!busy) setLogModal(false) }} title="Log a call"><form onSubmit={(event) => void submit(event)}><div className="form-row"><Field label="Direction"><select className="field-input" value={form.direction} onChange={(event) => setForm({ ...form, direction: event.target.value as CallDirection })}>{DIRECTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field><Field label="Status"><select className="field-input" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as CallStatus })}>{STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field></div><div className="form-row"><Field label="From"><input className="field-input mono" value={form.fromNumber} onChange={(event) => setForm({ ...form, fromNumber: event.target.value })} /></Field><Field label="To"><input className="field-input mono" value={form.toNumber} onChange={(event) => setForm({ ...form, toNumber: event.target.value })} /></Field></div><div className="form-row"><Field label="Caller name"><input className="field-input" value={form.callerName} onChange={(event) => setForm({ ...form, callerName: event.target.value })} /></Field><Field label="Duration (sec)"><input className="field-input mono" type="number" min="0" value={form.durationSec} onChange={(event) => setForm({ ...form, durationSec: event.target.value })} /></Field></div><Field label="Ticket id (optional)"><input className="field-input mono" value={form.ticketId} onChange={(event) => setForm({ ...form, ticketId: event.target.value })} /></Field><div className="modal-foot"><button type="button" className="btn btn-ghost" onClick={() => setLogModal(false)} disabled={busy}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Log call'}</button></div></form></Modal>

    <section className="form-panel"><div className="calls-quick-dial"><div><strong>Quick dial</strong><span className="muted">Opens your system or browser dialler and records the call intent.</span></div><div className="calls-dial-controls"><input className="field-input mono" value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="+44 20 0000 0000" aria-label="Phone number to call" /><button className="btn btn-primary btn-sm" disabled={phone.trim().length < 3} onClick={() => void dial(phone)}><Icon name="phone" size={14} />Call</button></div></div><div className="kb-toolbar"><input className="field-input" value={q} onChange={(event) => setQ(event.target.value)} placeholder="Search numbers or caller…" aria-label="Search calls" /><select className="field-input" value={direction} onChange={(event) => setDirection(event.target.value as CallDirection | '')} aria-label="Filter direction"><option value="">All directions</option>{DIRECTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select><select className="field-input" value={status} onChange={(event) => setStatus(event.target.value as CallStatus | '')} aria-label="Filter status"><option value="">All statuses</option>{STATUSES.map((item) => <option key={item} value={item}>{item}</option>)}</select></div><h3 className="channel-title">Call activity</h3>{calls === null ? <span className="etch">Loading calls…</span> : calls.length === 0 ? <p className="muted">No calls logged.</p> : <ul className="channel-list">{calls.map((call) => { const number = call.direction === 'inbound' ? call.from_number : call.to_number; return <li key={call.id} className="channel-card"><div className="channel-main"><span className="channel-name mono">{number || '—'}{call.caller_name ? ` · ${call.caller_name}` : ''}</span><span className="channel-meta mono">{call.direction} · {call.status} · {formatDuration(call.duration_sec)} · {new Date(call.started_at).toLocaleString()}</span></div><div className="channel-actions"><button className="btn btn-ghost btn-sm" onClick={() => void dial(number, call.ticket_id)} disabled={!number}><Icon name="phone" size={14} />Call</button>{call.ticket_id ? <Link className="btn btn-ghost btn-sm" to={`/tickets/${call.ticket_id}`}><Icon name="ticket" size={14} />#{call.ticket_number}</Link> : <span className="muted">{(call.ext?.match as { status?: string } | undefined)?.status === 'ambiguous' ? 'multiple ticket matches' : 'no ticket'}</span>}</div></li>})}</ul>}</section>
  </Shell>
}
