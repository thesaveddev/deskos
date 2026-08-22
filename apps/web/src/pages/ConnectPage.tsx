import { useCallback, useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { Alert, BrandRow } from '../components/ui.js'

interface ConnectInfo {
  state: string
  reason: string
  permissions: string[]
  helperAvailable: boolean
  claimMode: 'code' | 'email_link'
}

const PERMISSION_LABELS: Record<string, string> = {
  view_screen: 'View your screen',
  control_input: 'Move the mouse and type (remote control)',
  terminal: 'Open an elevated terminal',
  file_transfer: 'Send and receive files',
  clipboard: 'Synchronize the clipboard',
  system_manage: 'Manage running programs and services',
  elevation: 'Administrator (elevated) access',
  reboot_reconnect: 'Reconnect after a reboot',
}

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission
}

interface ChatMessage {
  sender_type: string
  body: string
  created_at: string
}

export default function ConnectPage() {
  const { code = '' } = useParams<{ code: string }>()
  const [searchParams] = useSearchParams()
  const claimToken = searchParams.get('claimToken')
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatStatus, setChatStatus] = useState<string | null>(null)
  const [consentState, setConsentState] = useState<'idle' | 'submitting' | 'granted' | 'denied'>('idle')
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const [ending, setEnding] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const query = claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ''
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}${query}`)
      if (!res.ok) {
        setInfo(null)
        setError('This support link is invalid or has expired. Ask your technician for a new one.')
        return
      }
      const next = (await res.json()) as ConnectInfo & { sessionId?: string; session_id?: string; remoteSessionId?: string; remote_session_id?: string; permissions?: string[]; consented?: boolean }
      setInfo(next)
      setSessionId(next.sessionId ?? next.session_id ?? next.remoteSessionId ?? next.remote_session_id ?? null)
      setSelectedPermissions(next.permissions ?? [])
      if (next.consented) setConsentState('granted')
    } catch {
      setInfo(null)
      setError('Could not reach the support service. Please check your connection and try again.')
    }
  }, [code, claimToken])

  const loadChat = useCallback(async () => {
    if (!sessionId) return
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}/messages`)
      if (!res.ok) return
      const body = (await res.json()) as { messages?: ChatMessage[] }
      setChatMessages(body.messages ?? [])
    } catch {
      // Keep the connection panel usable if chat history is temporarily unavailable.
    }
  }, [sessionId])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!sessionId) return
    void loadChat()
    const timer = window.setInterval(() => { void loadChat() }, 4000)
    return () => window.clearInterval(timer)
  }, [sessionId, loadChat])

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch { setCopied(false) }
  }

  const grantConsent = async () => {
    if (!sessionId) return
    setConsentState('submitting')
    try {
      const res = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/consent`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ granted: true, permissions: selectedPermissions }),
      })
      if (!res.ok) throw new Error('The support request could not be approved.')
      setConsentState('granted')
      await load()
    } catch (err) {
      setConsentState('idle')
      setError(err instanceof Error ? err.message : 'The support request could not be approved.')
    }
  }

  const denyConsent = async () => {
    if (!sessionId) return
    setConsentState('submitting')
    try {
      await fetch(`/api/connect/${encodeURIComponent(code)}/consent`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ granted: false }),
      })
      setConsentState('denied')
      await load()
    } catch {
      setConsentState('idle')
      setError('The support request could not be declined. Please try again.')
    }
  }

  const sendChat = async () => {
    if (!sessionId || !chatDraft.trim()) return
    const body = chatDraft.trim()
    setChatDraft('')
    setChatStatus('Sending…')
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
      })
      if (!res.ok) throw new Error('Message could not be sent.')
      setChatStatus('Sent')
      await loadChat()
    } catch (err) { setChatStatus(err instanceof Error ? err.message : 'Message could not be sent.') }
  }

  const endConnection = async () => {
    if (!sessionId || ending) return
    setEnding(true)
    try {
      const res = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!res.ok) throw new Error('The session could not be ended.')
      setConsentState('denied')
      setInfo((current) => current ? { ...current, state: 'ended' } : current)
    } catch (err) { setError(err instanceof Error ? err.message : 'The session could not be ended.') }
    finally { setEnding(false) }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel connect-panel">
        <BrandRow />
        <h1 className="auth-title">ReyDesk support</h1>
        <p className="auth-sub">Stay in control while your support team helps with this device.</p>
        {error ? <Alert kind="error">{error}</Alert> : null}
        {info ? <div className="connect-request">
          <div className="connect-reason"><span className="etch">Your technician asked to:</span><strong>{info.reason || 'Provide remote support'}</strong></div>
          {info.permissions.length > 0 ? <ul className="connect-permissions">{info.permissions.map((permission) => <li key={permission}>{permissionLabel(permission)}</li>)}</ul> : null}
          {['requested', 'consent_pending'].includes(info.state) && consentState !== 'denied' ? <section className="connect-consent-card">
            <strong>Approve this support request</strong>
            <p className="muted">Choose what your technician may do. You can end access at any time.</p>
            <div className="connect-permission-options">{info.permissions.map((permission) => <label key={permission}><input type="checkbox" checked={selectedPermissions.includes(permission)} onChange={(event) => setSelectedPermissions((current) => event.target.checked ? [...new Set([...current, permission])] : current.filter((item) => item !== permission))} />{permissionLabel(permission)}</label>)}</div>
            <div className="connect-actions"><button className="btn btn-primary" onClick={() => void grantConsent()} disabled={consentState === 'submitting'}>{consentState === 'submitting' ? 'Saving…' : 'Allow support'}</button><button className="btn btn-ghost" onClick={() => void denyConsent()} disabled={consentState === 'submitting'}>Decline</button></div>
          </section> : null}
          <div className="connect-code"><span className="etch">Support code</span><div className="support-code-digits">{code}</div><button className="btn btn-ghost btn-sm" onClick={() => void copyCode()}><span>{copied ? 'Copied' : 'Copy code'}</span></button></div>
          <section className="connect-how-to"><span className="settings-eyebrow">How this works</span><ol><li>Download and open the ReyDesk helper on this device.</li><li>Enter the 12-digit code shown above.</li><li>Review the requested permissions and approve only what you are comfortable sharing.</li><li>Keep this page open to chat with the technician and end support at any time.</li></ol></section>
          {info.helperAvailable ? <div className="connect-download"><a className="btn btn-primary" href={`/api/connect/${encodeURIComponent(code)}/download${claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ''}`}><span>Download the ReyDesk helper</span></a><span className="muted">The helper is portable: it runs for this support session and does not require installation.</span></div> : <div className="connect-download"><span className="muted">The helper download is temporarily unavailable. Ask your technician to provide the signed helper package.</span></div>}
          {consentState === 'granted' || info.state === 'active' ? <section className="connect-chat-card">
            <div className="connect-live-header"><div><strong>Support conversation</strong><span className="muted">Technician messages appear here while they work.</span></div><span className="status-pill status-active">Connected</span></div>
            <div className="connect-chat-log">{chatMessages.length === 0 ? <span className="muted">No messages yet. You can send a message when you need attention.</span> : chatMessages.map((message, index) => <div className={`connect-chat-message ${message.sender_type === 'agent' ? 'from-technician' : 'from-user'}`} key={`${message.created_at}-${index}`}><span className="muted">{message.sender_type === 'agent' ? 'Technician' : 'You'}</span><p>{message.body}</p></div>)}</div>
            <textarea className="field-input" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} placeholder="Message your technician…" rows={3} />
            <div className="connect-chat-footer"><span className="muted">{chatStatus ?? 'Press Enter to send'}</span><button className="btn btn-primary btn-sm" onClick={() => void sendChat()} disabled={!chatDraft.trim()}>Send message</button></div>
          </section> : null}
          {consentState === 'granted' || info.state === 'active' ? <button className="btn btn-danger btn-block" onClick={() => void endConnection()} disabled={ending}>{ending ? 'Ending support…' : 'End support session'}</button> : null}
          <p className="muted">Your approval is recorded. ReyDesk shows what access was granted and when the session ends.</p>
        </div> : null}
      </div>
    </div>
  )
}
