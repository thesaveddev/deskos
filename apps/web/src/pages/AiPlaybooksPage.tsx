import { useEffect, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { useAuth } from '../lib/auth.js'
import { createPlaybook, deletePlaybook, issueIdentityCredential, listIdentityCredentials, listPlaybooks, revokeIdentityCredential, reviewPlaybookAccess, revokePlaybookIdentity, rotatePlaybookIdentity, seedPlaybooks, updatePlaybook, type IdentityCredential, type Playbook } from '../lib/ai-worker.js'

// Must mirror the createSchema category enum in playbook.routes.ts.
const CATEGORIES = ['general', 'password_reset', 'software_install', 'printer', 'network', 'account_unlock', 'email', 'hardware', 'security', 'custom'] as const

export default function AiPlaybooksPage() {
  const auth = useAuth()
  const permissions = new Set(auth.memberships.flatMap((membership) => membership.permissions))
  const canManage = permissions.has('ai_agent.manage')
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null)
  const [selected, setSelected] = useState<Playbook | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [seedBusy, setSeedBusy] = useState(false)
  const [credentials, setCredentials] = useState<IdentityCredential[]>([])
  const [credentialBusy, setCredentialBusy] = useState(false)
  const [issuedToken, setIssuedToken] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Playbook | null>(null)
  const [formBusy, setFormBusy] = useState(false)
  const [form, setForm] = useState({ name: '', description: '', category: 'general', keywords: '', system_prompt: '', max_steps: 6, auto_approve_low_risk: true })

  const load = async () => {
    try {
      setPlaybooks((await listPlaybooks()).playbooks)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load playbooks')
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    setIssuedToken(null)
    if (!selected) { setCredentials([]); return }
    void listIdentityCredentials(selected.id).then((result) => setCredentials(result.credentials)).catch((err) => setError(err instanceof Error ? err.message : 'Could not load identity credentials'))
  }, [selected?.id])

  const toggle = async (playbook: Playbook) => {
    if (!canManage || busy) return
    setBusy(true); setError(null)
    try {
      const result = await updatePlaybook(playbook.id, { enabled: !playbook.enabled })
      setPlaybooks((current) => current?.map((item) => item.id === result.playbook.id ? result.playbook : item) ?? null)
      setSelected(result.playbook)
      setNotice(result.playbook.enabled ? 'Playbook enabled.' : 'Playbook disabled.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update playbook')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (!selected || !canManage || busy) return
    setBusy(true); setError(null)
    try {
      await deletePlaybook(selected.id)
      setPlaybooks((current) => current?.filter((item) => item.id !== selected.id) ?? null)
      setSelected(null)
      setNotice('Playbook deleted.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete playbook')
    } finally { setBusy(false) }
  }

  const rotateIdentity = async () => {
    if (!selected || !canManage || busy) return
    setBusy(true); setError(null)
    try {
      const result = await rotatePlaybookIdentity(selected.id)
      setSelected(result.playbook)
      setPlaybooks((current) => current?.map((item) => item.id === result.playbook.id ? result.playbook : item) ?? null)
      setNotice(`Identity rotated to version ${result.playbook.identity_version}; access review is required again.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rotate identity')
    } finally { setBusy(false) }
  }

  const revokeIdentity = async () => {
    if (!selected || !canManage || busy) return
    const reason = window.prompt('Why are you revoking this worker identity?', 'Security review required')?.trim()
    if (!reason) return
    setBusy(true); setError(null)
    try {
      const result = await revokePlaybookIdentity(selected.id, reason)
      setSelected(result.playbook)
      setPlaybooks((current) => current?.map((item) => item.id === result.playbook.id ? result.playbook : item) ?? null)
      setNotice('Worker identity revoked and playbook disabled.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke identity')
    } finally { setBusy(false) }
  }

  const reviewAccess = async () => {
    if (!selected || !canManage || busy) return
    setBusy(true); setError(null)
    try {
      const result = await reviewPlaybookAccess(selected.id)
      setSelected(result.playbook)
      setPlaybooks((current) => current?.map((item) => item.id === result.playbook.id ? result.playbook : item) ?? null)
      setNotice('Least-privilege access review recorded.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record access review')
    } finally { setBusy(false) }
  }

  const issueCredential = async () => {
    if (!selected || !canManage || credentialBusy) return
    const name = window.prompt('Credential name', 'External AI client')?.trim()
    if (!name) return
    const daysText = window.prompt('Expires in how many days? (1-365)', '90')?.trim() ?? '90'
    const expiresInDays = Number(daysText)
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) { setError('Credential expiry must be between 1 and 365 days.'); return }
    setCredentialBusy(true); setError(null); setIssuedToken(null)
    try {
      const result = await issueIdentityCredential(selected.id, { name, expiresInDays })
      setCredentials((current) => [result.credential, ...current])
      setIssuedToken(result.token)
      setNotice('Credential created. Copy it now; ReyDesk will not show the secret again.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not issue credential') } finally { setCredentialBusy(false) }
  }

  const revokeCredential = async (credential: IdentityCredential) => {
    if (!selected || !canManage || credentialBusy || credential.status !== 'active') return
    if (!window.confirm(`Revoke credential “${credential.name}”?`)) return
    setCredentialBusy(true); setError(null)
    try {
      const result = await revokeIdentityCredential(selected.id, credential.id)
      setCredentials((current) => current.map((item) => item.id === result.credential.id ? result.credential : item))
      setNotice('Credential revoked.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not revoke credential') } finally { setCredentialBusy(false) }
  }

  const openNew = () => {
    setEditTarget(null)
    setForm({ name: '', description: '', category: 'general', keywords: '', system_prompt: '', max_steps: 6, auto_approve_low_risk: true })
    setError(null)
    setFormOpen(true)
  }

  const openEdit = (playbook: Playbook) => {
    setEditTarget(playbook)
    setForm({
      name: playbook.name,
      description: playbook.description,
      category: playbook.category,
      keywords: playbook.trigger_keywords.join(', '),
      system_prompt: playbook.system_prompt,
      max_steps: playbook.max_steps,
      auto_approve_low_risk: playbook.auto_approve_low_risk,
    })
    setError(null)
    setFormOpen(true)
  }

  const submitForm = async (event: FormEvent) => {
    event.preventDefault()
    if (formBusy || !form.name.trim() || !form.system_prompt.trim()) return
    setFormBusy(true)
    setError(null)
    const body = {
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category,
      trigger_keywords: form.keywords.split(',').map((word) => word.trim()).filter(Boolean),
      system_prompt: form.system_prompt.trim(),
      max_steps: Math.min(12, Math.max(1, Number(form.max_steps) || 6)),
      auto_approve_low_risk: form.auto_approve_low_risk,
    }
    try {
      const result = editTarget ? await updatePlaybook(editTarget.id, body) : await createPlaybook(body)
      setPlaybooks((current) => {
        if (!current) return [result.playbook]
        return editTarget
          ? current.map((item) => item.id === result.playbook.id ? result.playbook : item)
          : [result.playbook, ...current]
      })
      setSelected(result.playbook)
      setNotice(editTarget
        ? 'Playbook updated.'
        : result.playbook.enabled
          ? 'Playbook created.'
          : 'Playbook created disabled. Record an access review before enabling it.')
      setFormOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save playbook')
    } finally {
      setFormBusy(false)
    }
  }

  const seed = async () => {
    if (!canManage || seedBusy) return
    setSeedBusy(true); setError(null)
    try {
      const result = await seedPlaybooks()
      setNotice(result.message)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not seed playbooks')
    } finally { setSeedBusy(false) }
  }

  if (!canManage && !permissions.has('ai_agent.read')) {
    return <Shell><Alert kind="error">You do not have permission to view AI playbooks.</Alert></Shell>
  }

  return (
    <Shell>
      <PageHeader
        title="AI playbooks"
        subtitle="Reusable, governed instructions for AI workers. Review every playbook before allowing it to act on live service work."
        actions={canManage ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={openNew}>New playbook</button>
            <button className="btn btn-ghost btn-sm" onClick={() => void seed()} disabled={seedBusy}><Icon name="sparkles" size={14} />{seedBusy ? 'Seeding…' : 'Seed built-in playbooks'}</button>
          </>
        ) : undefined}
      />
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      <div className="ai-playbooks-layout">
        <section className="panel ai-playbooks-list">
          <div className="panel-head"><div className="panel-head-main"><span className="panel-title">Worker library</span><span className="panel-sub">{playbooks?.length ?? 0} playbooks</span></div></div>
          {playbooks === null ? <div className="panel-empty">Loading playbooks…</div> : playbooks.length === 0 ? <div className="panel-empty">No playbooks yet. Create one, or seed the built-in L1 library to get started.</div> : (
            <div className="ai-playbook-list">
              {playbooks.map((playbook) => (
                <button type="button" key={playbook.id} className={`ai-playbook-row${selected?.id === playbook.id ? ' active' : ''}`} onClick={() => setSelected(playbook)}>
                  <span className="ai-playbook-row-icon"><Icon name="sparkles" size={15} /></span>
                  <span className="ai-playbook-row-copy"><strong>{playbook.name}</strong><small>{playbook.category} · {playbook.usage_count} runs · {Number(playbook.success_rate).toFixed(0)}% success</small></span>
                  <span className={`status-pill ${playbook.enabled ? 'status-resolved' : 'status-muted'}`}>{playbook.enabled ? 'Enabled' : 'Disabled'}</span>
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="panel ai-playbook-detail">
          {selected ? (
            <>
              <div className="panel-head"><div className="panel-head-main"><span className="etch">Playbook detail</span><span className="panel-title">{selected.name}</span><span className="panel-sub">{selected.description}</span></div><span className={`status-pill ${selected.enabled ? 'status-resolved' : 'status-muted'}`}>{selected.enabled ? 'Enabled' : 'Disabled'}</span></div>
              <div className="ai-playbook-detail-body">
                <div className="ai-playbook-stat-row"><div><span className="etch">Category</span><strong>{selected.category}</strong></div><div><span className="etch">Max steps</span><strong>{selected.max_steps}</strong></div><div><span className="etch">Success rate</span><strong>{Number(selected.success_rate).toFixed(0)}%</strong></div></div>
                <div><span className="etch">Trigger keywords</span><div className="ai-playbook-keywords">{selected.trigger_keywords.length ? selected.trigger_keywords.map((keyword) => <span key={keyword}>{keyword}</span>) : <small>No keywords configured</small>}</div></div>
                <div><span className="etch">Worker instructions</span><pre className="ai-playbook-prompt">{selected.system_prompt}</pre></div>
                <div className="ai-playbook-identity"><div><span className="etch">Machine identity</span><strong className="mono">{selected.machine_identity} v{selected.identity_version}</strong><span className={selected.identity_status === 'active' ? 'sla-ok' : 'sla-crit'}>{selected.identity_status === 'active' ? 'Active' : 'Revoked'}</span></div><div><span className="etch">Allowed tools</span><span className="ai-playbook-tools">{selected.allowed_tools.length ? selected.allowed_tools.join(' · ') : 'Uses tenant tool-permission matrix'}</span></div><div><span className="etch">Access review</span><span className={selected.access_reviewed_at ? 'sla-ok' : 'sla-warn'}>{selected.access_reviewed_at ? `Reviewed ${new Date(selected.access_reviewed_at).toLocaleString()}` : 'Review required before enablement'}</span></div></div>
                <div className="ai-playbook-credentials"><div className="ai-playbook-credentials-head"><div><span className="etch">External credentials</span><small>Secrets are hashed, expiring, and shown only once.</small></div>{canManage ? <button className="btn btn-outline btn-sm" onClick={() => void issueCredential()} disabled={credentialBusy || selected.identity_status === 'revoked'}>{credentialBusy ? 'Working…' : 'Issue credential'}</button> : null}</div>{issuedToken ? <div className="ai-playbook-token"><strong>Copy this secret now</strong><code>{issuedToken}</code><button className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText(issuedToken)}>Copy</button></div> : null}{credentials.length === 0 ? <small>No credentials issued.</small> : <div className="ai-playbook-credential-list">{credentials.map((credential) => <div className="ai-playbook-credential" key={credential.id}><span><strong>{credential.name}</strong><small>{credential.token_prefix} · {credential.usage_count} uses · expires {new Date(credential.expires_at).toLocaleDateString()}</small></span><span className={credential.status === 'active' ? 'sla-ok' : 'sla-crit'}>{credential.status}</span>{canManage && credential.status === 'active' ? <button className="btn btn-ghost btn-sm" onClick={() => void revokeCredential(credential)} disabled={credentialBusy}>Revoke</button> : null}</div>)}</div>}</div>
                <div className="ai-playbook-safety"><Icon name="shield" size={16} /><span>High-risk actions require approval. This playbook is subject to the tenant tool permission matrix and every action is audit logged.</span></div>
                {canManage ? <div className="ai-playbook-actions"><button className="btn btn-outline btn-sm" onClick={() => openEdit(selected)} disabled={busy}>Edit playbook</button><button className="btn btn-primary btn-sm" onClick={() => void toggle(selected)} disabled={busy || selected.identity_status === 'revoked' || (!selected.enabled && !selected.access_reviewed_at)}>{selected.enabled ? 'Disable playbook' : 'Enable playbook'}</button><button className="btn btn-outline btn-sm" onClick={() => void reviewAccess()} disabled={busy || selected.identity_status === 'revoked'}>Review access</button><button className="btn btn-ghost btn-sm" onClick={() => void rotateIdentity()} disabled={busy}>Rotate identity</button><button className="btn btn-danger btn-sm" onClick={() => void revokeIdentity()} disabled={busy || selected.identity_status === 'revoked'}>Revoke identity</button><button className="btn btn-danger btn-sm" onClick={() => void remove()} disabled={busy}>Delete playbook</button></div> : null}
              </div>
            </>
          ) : <div className="panel-empty">Select a playbook to review its instructions and safety posture.</div>}
        </section>
      </div>

      <Modal
        open={formOpen}
        onClose={() => { if (!formBusy) setFormOpen(false) }}
        title={editTarget ? 'Edit playbook' : 'New playbook'}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setFormOpen(false)} disabled={formBusy}>Cancel</button>
            <button type="submit" form="playbook-form" className="btn btn-primary" disabled={formBusy || !form.name.trim() || !form.system_prompt.trim()}>
              {formBusy ? 'Saving…' : editTarget ? 'Save changes' : 'Create playbook'}
            </button>
          </>
        }
      >
        <form id="playbook-form" onSubmit={(event) => void submitForm(event)}>
          <Field label="Name" hint="Shown in the worker library and in approval requests.">
            <input className="field-input" placeholder="Password reset worker" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <input className="field-input" placeholder="What this playbook handles" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Category">
            <select className="field-input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((category) => <option key={category} value={category}>{category.replace(/_/g, ' ')}</option>)}
            </select>
          </Field>
          <Field label="Trigger keywords" hint="Comma separated — matched against incoming tickets.">
            <input className="field-input" placeholder="password, reset, locked out" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })} />
          </Field>
          <Field label="Worker instructions" hint="The instructions the worker follows on every run. High-risk actions require approval regardless of the setting below.">
            <textarea className="field-input" rows={6} style={{ height: 'auto', padding: '8px 12px', resize: 'vertical' }} placeholder="Read the ticket, confirm the requester's identity, then…" value={form.system_prompt} onChange={(e) => setForm({ ...form, system_prompt: e.target.value })} />
          </Field>
          <Field label="Max steps" hint="1–12. Caps how many actions one run may take.">
            <input className="field-input" type="number" min={1} max={12} value={form.max_steps} onChange={(e) => setForm({ ...form, max_steps: Number(e.target.value) })} />
          </Field>
          <div className="field" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: 'var(--text-2)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.auto_approve_low_risk} onChange={(e) => setForm({ ...form, auto_approve_low_risk: e.target.checked })} />
              Auto-approve low-risk steps
            </label>
          </div>
        </form>
      </Modal>
    </Shell>
  )
}
