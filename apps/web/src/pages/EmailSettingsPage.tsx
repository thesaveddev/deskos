import { useCallback, useEffect, useState } from 'react'
import { Alert, Field, useConfirm } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import {
  createEmailChannel,
  deleteEmailChannel,
  getEmailStatus,
  getOutboundEmailStatus,
  listEmailChannels,
  pollAllEmailChannels,
  pollEmailChannel,
  testEmailChannel,
  testEmailConnection,
  updateEmailChannel,
  type EmailChannel,
  type EmailChannelInput,
} from '../lib/emailChannels.js'

const EMPTY_FORM: EmailChannelInput = {
  name: '',
  address: '',
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  imapPass: '',
  imapTls: true,
}

export default function EmailSettingsPage() {
  const [channels, setChannels] = useState<EmailChannel[]>([])
  const [status, setStatus] = useState<{ enabled: boolean; running: boolean; lastPollAt: string | null; lastError: string | null } | null>(null)
  const [outbound, setOutbound] = useState<Awaited<ReturnType<typeof getOutboundEmailStatus>> | null>(null)
  const [form, setForm] = useState<EmailChannelInput>(EMPTY_FORM)
  const [editing, setEditing] = useState<EmailChannel | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const confirm = useConfirm()

  const refresh = useCallback(() => {
    void listEmailChannels()
      .then((r) => setChannels(r.channels))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load channels'))
    void getEmailStatus()
      .then((s) => setStatus(s))
      .catch(() => setStatus(null))
    void getOutboundEmailStatus()
      .then((s) => setOutbound(s))
      .catch(() => setOutbound(null))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  function setField<K extends keyof EmailChannelInput>(key: K, value: EmailChannelInput[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (editing) {
        const patch: Partial<EmailChannelInput> = { ...form }
        if (!patch.imapPass) delete patch.imapPass
        await updateEmailChannel(editing.id, patch)
        setNotice('Channel updated.')
      } else {
        await createEmailChannel(form)
        setNotice('Channel created. Emails to this inbox will convert into tickets here.')
      }
      setForm(EMPTY_FORM)
      setEditing(null)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(channel: EmailChannel) {
    setEditing(channel)
    setForm({
      name: channel.name,
      address: channel.address,
      imapHost: channel.imapHost,
      imapPort: channel.imapPort,
      imapUser: channel.imapUser,
      imapPass: '',
      imapTls: channel.imapTls,
      enabled: channel.enabled,
    })
    setError(null)
    setNotice(null)
  }

  function cancelEdit() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setError(null)
    setNotice(null)
  }

  async function handleTest(channel: EmailChannel) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await testEmailChannel(channel.id)
      setNotice(r.unseen !== undefined ? `Connected OK — ${r.unseen} unseen message(s) waiting.` : 'Connected OK.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleTestForm() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await testEmailConnection({
        imapHost: form.imapHost,
        imapPort: form.imapPort,
        imapUser: form.imapUser,
        imapPass: form.imapPass,
        imapTls: form.imapTls,
      })
      setNotice(r.unseen !== undefined ? `Connected OK — ${r.unseen} unseen message(s) waiting.` : 'Connected OK.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  async function handlePoll(channel: EmailChannel) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await pollEmailChannel(channel.id)
      setNotice(`Polled: ${r.processed} processed, ${r.created} created, ${r.replied} replied.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Poll failed')
    } finally {
      setBusy(false)
    }
  }

  async function handlePollAll() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const r = await pollAllEmailChannels()
      setNotice(`All channels polled: ${r.processed} processed, ${r.created} created.`)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Poll failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(channel: EmailChannel) {
    if (!await confirm(`Delete channel “${channel.name}”? Incoming email will stop creating tickets here.`, { title: 'Delete email channel', confirmLabel: 'Delete channel', destructive: true })) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await deleteEmailChannel(channel.id)
      if (editing?.id === channel.id) cancelEdit()
      setNotice('Channel deleted.')
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggle(channel: EmailChannel) {
    setBusy(true)
    try {
      await updateEmailChannel(channel.id, { enabled: !channel.enabled })
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Toggle failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Email channels</h1>
        <div className="page-actions">
          <button className="btn btn-ghost" onClick={handlePollAll} disabled={busy}>
            Poll all now
          </button>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="email-status-bar">
        <span>
          Outbound SMTP: <strong className={outbound?.enabled ? 'sla-ok' : 'sla-crit'}>{outbound?.enabled ? 'ready' : 'not configured'}</strong>
          {outbound?.enabled ? ` · ${outbound.host}:${outbound.port}` : ''}
        </span>
        <span>
          Poller: <strong>{status?.enabled ? 'on' : 'off'}</strong>
          {status?.running ? ' (running)' : ''}
        </span>
        {status?.lastPollAt ? (
          <span className="muted">last poll {new Date(status.lastPollAt).toLocaleTimeString()}</span>
        ) : null}
        {status?.lastError ? <span className="sla-crit">error: {status.lastError}</span> : null}
        {outbound && outbound.queue.dead > 0 ? <span className="sla-crit">{outbound.queue.dead} email(s) failed permanently</span> : null}
      </div>

      {channels.length === 0 && !editing ? (
        <div className="empty-state">
          No email channels yet. Add your support inbox below — every email you receive will create a ticket in this
          tenant.
        </div>
      ) : null}

      {channels.length > 0 ? (
        <div className="channel-list">
          {channels.map((c) => (
            <div key={c.id} className="channel-card">
              <div className="channel-main">
                <div className="channel-title">
                  <span className="channel-name">{c.name}</span>
                  <span className={`status-pill ${c.enabled ? 'status-open' : 'status-resolved'}`}>
                    {c.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="channel-meta muted">
                  {c.address} · {c.imapHost}:{c.imapPort} · {c.imapUser}
                </div>
              </div>
              <div className="channel-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => handleTest(c)} disabled={busy}>
                  Test
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handlePoll(c)} disabled={busy}>
                  Poll
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handleToggle(c)} disabled={busy}>
                  {c.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => startEdit(c)} disabled={busy}>
                  Edit
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => handleDelete(c)} disabled={busy}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="form-panel channel-form">
        <h2 className="channel-form-title">{editing ? `Edit channel — ${editing.name}` : 'Add an email channel'}</h2>
        <form onSubmit={handleSave}>
          <div className="form-row">
            <Field label="Name" hint="e.g. Support inbox">
              <input className="field-input" value={form.name} onChange={(e) => setField('name', e.target.value)} required />
            </Field>
            <Field label="Email address" hint="What customers write to (this tenant)">
              <input className="field-input" type="email" value={form.address} onChange={(e) => setField('address', e.target.value)} required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="IMAP host">
              <input className="field-input" value={form.imapHost} onChange={(e) => setField('imapHost', e.target.value)} placeholder="mail.example.com" required />
            </Field>
            <Field label="Port">
              <input className="field-input" type="number" value={form.imapPort} onChange={(e) => setField('imapPort', Number(e.target.value))} required />
            </Field>
          </div>
          <div className="form-row">
            <Field label="IMAP username">
              <input className="field-input" value={form.imapUser} onChange={(e) => setField('imapUser', e.target.value)} required />
            </Field>
            <PasswordField label="Password" hint={editing ? 'Leave blank to keep the current one' : undefined} className="field-input" value={form.imapPass} onChange={(e) => setField('imapPass', e.target.value)} required={!editing} />
          </div>
          <label className="field checkbox-field">
            <span className="field-label">Use SSL/TLS (port 993)</span>
            <input type="checkbox" checked={form.imapTls} onChange={(e) => setField('imapTls', e.target.checked)} />
          </label>
          <div className="form-actions">
            {editing ? (
              <button type="button" className="btn btn-ghost" onClick={cancelEdit}>
                Cancel
              </button>
            ) : null}
            <button type="button" className="btn btn-ghost" onClick={handleTestForm} disabled={busy || !form.imapHost || !form.imapUser || !form.imapPass}>
              Test connection
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add channel'}
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
