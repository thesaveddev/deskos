import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Alert, BrandRow } from '../components/ui.js'

interface ConnectInfo {
  state: string
  reason: string
  permissions: string[]
  helperAvailable: boolean
  macHelperAvailable?: boolean
  androidHelperAvailable?: boolean
  platform?: 'windows' | 'macos' | 'linux' | 'ios' | 'ipados' | 'android' | 'unknown'
  helperSupported?: boolean
  claimMode: 'code' | 'email_link'
  sessionState?: string
  sessionId?: string
}

interface ChatMessage {
  sender_type: string
  body: string
  created_at: string
  attachment?: { kind: 'image' | 'file'; name?: string; dataUrl?: string }
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

const CHAT_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉', '😅', '👋', '✅', '💻', '🔧']
const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g

function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? permission
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function firstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN)
  return match ? match[0] : null
}

function linkifyText(text: string): ReactNode[] {
  const parts = text.split(URL_PATTERN)
  return parts.map((part, index) =>
    part.startsWith('http://') || part.startsWith('https://')
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="chat-link">{part}</a>
      : <span key={index}>{part}</span>,
  )
}

function relayUrl(): string {
  const configured = (import.meta as ImportMeta & { env?: { VITE_RELAY_URL?: string } }).env?.VITE_RELAY_URL
  if (configured) return configured
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${protocol}://${window.location.host}/ws`
}

export default function ConnectPage() {
  const navigate = useNavigate()
  const { code = '' } = useParams<{ code: string }>()
  const [searchParams] = useSearchParams()
  const [entryCode, setEntryCode] = useState('')
  const claimToken = searchParams.get('claimToken')
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [deviceToken, setDeviceToken] = useState<string | null>(() => sessionStorage.getItem(`reydesk-connect-token-${code}`))
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [chatStatus, setChatStatus] = useState<string | null>(null)
  const [peerTyping, setPeerTyping] = useState(false)
  const [consentState, setConsentState] = useState<'idle' | 'submitting' | 'granted' | 'denied'>('idle')
  const [selectedPermissions, setSelectedPermissions] = useState<string[]>([])
  const [ending, setEnding] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const relayRef = useRef<WebSocket | null>(null)
  const relayJoinedRef = useRef(false)
  const chatLogRef = useRef<HTMLDivElement | null>(null)
  const seenKeysRef = useRef<Set<string>>(new Set())
  const typingTimerRef = useRef<number | undefined>(undefined)

  const tokenKey = `reydesk-connect-token-${code}`

  const authHeaders = (token: string): Record<string, string> => ({
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  })

  const load = useCallback(async () => {
    if (!code) return
    setError(null)
    try {
      const query = claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ''
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}${query}`)
      if (!res.ok) {
        setInfo(null)
        const payload = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
        setError(payload?.error?.message ?? 'This support link is invalid or has expired. Ask your technician for a new one.')
        return
      }
      const next = (await res.json()) as ConnectInfo & { session_id?: string; remote_session_id?: string; consented?: boolean }
      setInfo(next)
      setSessionId(next.sessionId ?? next.session_id ?? next.remote_session_id ?? null)
      setSelectedPermissions((current) => current.length > 0 ? current : (next.permissions ?? []))
      if (next.consented) setConsentState('granted')
    } catch {
      setInfo(null)
      setError('Could not reach the support service. Please check your connection and try again.')
    }
  }, [code, claimToken])

  // Claim the code with this browser so consent + chat work end to end. The
  // single-use code means the helper can still attach afterwards via
  // /connect/:code/agent-join as the streaming engine.
  const ensureDevice = useCallback(async (): Promise<string | null> => {
    const existing = sessionStorage.getItem(tokenKey)
    if (existing) return existing
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'This device', os: navigator.platform ?? '', hostname: navigator.userAgent.split(' ')[0] ?? '' }),
      })
      if (!res.ok) return null
      const body = (await res.json()) as { deviceToken?: string; session?: { id: string } }
      if (!body.deviceToken) return null
      sessionStorage.setItem(tokenKey, body.deviceToken)
      setDeviceToken(body.deviceToken)
      if (body.session?.id) setSessionId(body.session.id)
      await load()
      return body.deviceToken
    } catch {
      return null
    }
  }, [code, tokenKey, load])

  const joinRelay = useCallback(async (token: string) => {
    if (relayRef.current || relayJoinedRef.current) return
    try {
      // With a device token we join as the companion; without one (helper
      // claimed first) we attach via agent-join, chat-only.
      const url = token
        ? `/api/connect/${encodeURIComponent(code)}/join`
        : `/api/connect/${encodeURIComponent(code)}/companion-join`
      const res = await fetch(url, token
        ? { method: 'POST', headers: authHeaders(token), body: '{}' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      if (!res.ok) return
      const body = (await res.json()) as { joinToken?: string; sessionId?: string }
      if (!body.joinToken || !body.sessionId) return
      setSessionId(body.sessionId)
      const socket = new WebSocket(relayUrl())
      relayRef.current = socket
      socket.onopen = () => socket.send(JSON.stringify({ type: 'join', sessionId: body.sessionId, joinToken: body.joinToken }))
      socket.onmessage = (event) => {
        let message: Record<string, unknown>
        try {
          message = JSON.parse(event.data as string) as Record<string, unknown>
        } catch {
          return
        }
        if (message.type === 'joined') relayJoinedRef.current = true
        if (message.type === 'chat' && typeof message.body === 'string') {
          const rawAttachment = message.attachment as { kind?: string; name?: string; dataUrl?: string } | undefined
          const attachment: ChatMessage['attachment'] = rawAttachment && (rawAttachment.kind === 'image' || rawAttachment.kind === 'file')
            ? { kind: rawAttachment.kind, name: rawAttachment.name, dataUrl: rawAttachment.dataUrl }
            : undefined
          const chatMessage: ChatMessage = {
            sender_type: typeof message.from === 'string' ? message.from : 'technician',
            body: message.body as string,
            created_at: new Date().toISOString(),
            attachment,
          }
          setChatMessages((current) => [...current, chatMessage])
          setPeerTyping(false)
        }
        if (message.type === 'typing') setPeerTyping(message.active !== false)
        if (message.type === 'session_end') {
          setConsentState('denied')
          setInfo((current) => current ? { ...current, state: 'ended' } : current)
        }
      }
      socket.onclose = () => {
        relayRef.current = null
        relayJoinedRef.current = false
      }
    } catch {
      // Relay is optional — REST polling still delivers chat.
    }
  }, [code])

  const loadChat = useCallback(async () => {
    const token = sessionStorage.getItem(tokenKey) ?? deviceToken
    if (!sessionId || !code) return
    try {
      const url = token
        ? `/api/connect/${encodeURIComponent(code)}/messages`
        : `/api/connect/${encodeURIComponent(code)}/companion/messages`
      const res = await fetch(url, token ? { headers: authHeaders(token) } : undefined)
      if (!res.ok) return
      const body = (await res.json()) as { messages?: ChatMessage[] }
      for (const message of body.messages ?? []) {
        const key = `${message.sender_type}:${message.body}:${message.created_at}`
        if (seenKeysRef.current.has(key)) continue
        seenKeysRef.current.add(key)
        setChatMessages((current) => {
          const duplicate = current.some((existing) =>
            existing.sender_type === message.sender_type &&
            existing.body === message.body &&
            Math.abs(Date.parse(existing.created_at) - Date.parse(message.created_at)) < 15_000,
          )
          return duplicate ? current : [...current, message]
        })
      }
    } catch {
      // Chat history is best-effort.
    }
  }, [code, sessionId, deviceToken])

  useEffect(() => { void load() }, [load])

  // Browser-based support: an open (unclaimed) code must be claimed by this
  // browser so the consent card and chat appear. The helper can still attach
  // afterwards via /connect/:code/agent-join as the streaming engine. Only
  // mark the attempt done when the claim actually succeeds so a transient
  // failure retries on the next info refresh.
  const claimedRef = useRef(false)
  useEffect(() => {
    if (!info || claimedRef.current) return
    if (info.state === 'open' && !sessionStorage.getItem(tokenKey)) {
      void ensureDevice().then((token) => {
        if (token) claimedRef.current = true
      })
    }
  }, [info, tokenKey, ensureDevice])

  useEffect(() => {
    if (!sessionId) return
    void loadChat()
    const timer = window.setInterval(() => { void loadChat() }, 3000)
    return () => window.clearInterval(timer)
  }, [sessionId, loadChat])

  useEffect(() => {
    if (!info || !sessionId || consentState === 'denied') return
    const live = ['claimed', 'connecting', 'active', 'reconnecting'].includes(info.state) || consentState === 'granted'
    if (live) void joinRelay(deviceToken ?? sessionStorage.getItem(tokenKey) ?? '')
  }, [info, sessionId, consentState, deviceToken, tokenKey, joinRelay])

  useEffect(() => {
    const el = chatLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, peerTyping])

  useEffect(() => {
    if (!emojiOpen) return
    const close = () => setEmojiOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [emojiOpen])

  const submitEntryCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = entryCode.replace(/\D/g, '')
    if (normalized.length !== 12) {
      setError('Enter the 12-digit technician code you were given.')
      return
    }
    navigate(`/connect/${normalized}`)
  }

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
    let token = deviceToken ?? sessionStorage.getItem(tokenKey)
    if (!token) token = await ensureDevice()
    if (!token) {
      setConsentState('idle')
      setError('The support request could not be approved. Please try again.')
      return
    }
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}/consent`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ granted: true, permissions: selectedPermissions }),
      })
      if (!res.ok) throw new Error('The support request could not be approved.')
      setConsentState('granted')
      await load()
      void joinRelay(token)
    } catch (err) {
      setConsentState('idle')
      setError(err instanceof Error ? err.message : 'The support request could not be approved.')
    }
  }

  const denyConsent = async () => {
    if (!sessionId) return
    setConsentState('submitting')
    let token = deviceToken ?? sessionStorage.getItem(tokenKey)
    if (!token) token = await ensureDevice()
    if (!token) {
      setConsentState('idle')
      setError('The support request could not be declined. Please try again.')
      return
    }
    try {
      const res = await fetch(`/api/connect/${encodeURIComponent(code)}/consent`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ granted: false }),
      })
      if (!res.ok) throw new Error('The support request could not be declined.')
      setConsentState('denied')
      await load()
    } catch (err) {
      setConsentState('idle')
      setError(err instanceof Error ? err.message : 'The support request could not be declined.')
    }
  }

  const sendChat = async () => {
    if (!sessionId || !chatDraft.trim()) return
    const body = chatDraft.trim()
    setChatDraft('')
    setChatStatus('Sending…')
    let token = deviceToken ?? sessionStorage.getItem(tokenKey)
    if (!token && !['claimed', 'connecting', 'active', 'reconnecting'].includes(info?.state ?? '')) {
      token = await ensureDevice()
    }
    const messageUrl = token
      ? `/api/connect/${encodeURIComponent(code)}/messages`
      : `/api/connect/${encodeURIComponent(code)}/companion/messages`
    let delivered = false
    try {
      const response = await fetch(messageUrl, {
        method: 'POST',
        headers: token ? authHeaders(token) : { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      if (!response.ok) throw new Error('Message could not be sent.')
      delivered = true
    } catch (err) {
      setChatStatus(err instanceof Error ? err.message : 'Message could not be sent.')
    }
    if (relayRef.current && relayJoinedRef.current && relayRef.current.readyState === WebSocket.OPEN) {
      relayRef.current.send(JSON.stringify({ type: 'chat', body }))
      delivered = true
    }
    if (delivered) {
      setChatMessages((current) => [...current, { sender_type: 'agent', body, created_at: new Date().toISOString() }])
      setChatStatus('Sent')
      await loadChat()
    } else {
      setChatStatus('The support page is not connected yet. Please try again.')
    }
    if (token) void joinRelay(token)
  }

  const sendTyping = (active: boolean) => {
    if (relayRef.current && relayJoinedRef.current && relayRef.current.readyState === WebSocket.OPEN) {
      relayRef.current.send(JSON.stringify({ type: 'typing', active }))
    }
  }

  const endConnection = async () => {
    if (!sessionId || ending) return
    setEnding(true)
    const token = deviceToken ?? sessionStorage.getItem(tokenKey)
    try {
      const res = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/end`, {
        method: 'POST',
        headers: token ? authHeaders(token) : { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) throw new Error('The session could not be ended.')
      setConsentState('denied')
      setInfo((current) => current ? { ...current, state: 'ended' } : current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The session could not be ended.')
    } finally {
      setEnding(false)
    }
  }

  if (!code) {
    return (
      <div className="auth-screen">
        <div className="auth-panel connect-panel connect-entry-panel">
          <BrandRow />
          <span className="settings-eyebrow">Secure remote support</span>
          <h1 className="auth-title">Connect to your technician</h1>
          <p className="auth-sub">Enter the 12-digit technician code provided by your support team. You will review and approve every permission before access begins.</p>
          {error ? <Alert kind="error">{error}</Alert> : null}
          <form className="connect-entry-form" onSubmit={submitEntryCode}>
            <label className="field">
              <span className="field-label">Technician code</span>
              <input className="field-input connect-entry-input" value={entryCode} onChange={(event) => setEntryCode(event.target.value.replace(/\D/g, '').slice(0, 12))} inputMode="numeric" pattern="[0-9]{12}" maxLength={12} placeholder="000 000 000 000" autoComplete="one-time-code" autoFocus required />
              <span className="field-hint">12 digits · single-use · provided by your technician</span>
            </label>
            <button className="btn btn-primary btn-block" type="submit">Continue securely</button>
          </form>
          <p className="connect-entry-note">No account is needed. Do not share a code with anyone other than the technician assisting you.</p>
        </div>
      </div>
    )
  }

  const canConsent = info && ['requested', 'consent_pending'].includes(info.sessionState ?? info.state) && consentState !== 'denied'
  const canChat = info && (consentState === 'granted' || ['claimed', 'connecting', 'active', 'reconnecting'].includes(info.state) || ['connecting', 'active', 'reconnecting'].includes(info.sessionState ?? ''))

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
          {canConsent ? <section className="connect-consent-card">
            <strong>Approve this support request</strong>
            <p className="muted">Choose what your technician may do. You can end access at any time.</p>
            <div className="connect-permission-options">{info.permissions.map((permission) => <label key={permission}><input type="checkbox" checked={selectedPermissions.includes(permission)} onChange={(event) => setSelectedPermissions((current) => event.target.checked ? [...new Set([...current, permission])] : current.filter((item) => item !== permission))} />{permissionLabel(permission)}</label>)}</div>
            <div className="connect-actions"><button className="btn btn-primary" onClick={() => void grantConsent()} disabled={consentState === 'submitting'}>{consentState === 'submitting' ? 'Saving…' : 'Allow support'}</button><button className="btn btn-ghost" onClick={() => void denyConsent()} disabled={consentState === 'submitting'}>Decline</button></div>
          </section> : null}
          <div className="connect-code"><span className="etch">Support code</span><div className="support-code-digits">{code}</div><button className="btn btn-ghost btn-sm" onClick={() => void copyCode()}><span>{copied ? 'Copied' : 'Copy code'}</span></button></div>
          <section className="connect-how-to"><span className="settings-eyebrow">How this works</span><ol><li>Review the requested permissions above and approve only what you are comfortable sharing.</li><li>If your screen needs to be shared, download and open the ReyDesk helper on this device — it connects with this same code.</li><li>Keep this page open to chat with the technician and end support at any time.</li></ol></section>
          {info.helperSupported ? <div className="connect-download"><a className="btn btn-primary" href={`/api/connect/${encodeURIComponent(code)}/download${claimToken ? `?claimToken=${encodeURIComponent(claimToken)}` : ''}`}><span>{info.platform === 'android' ? 'Download the ReyDesk Android agent' : `Download the ${info.platform === 'macos' ? 'macOS' : 'Windows'} ReyDesk helper`}</span></a><span className="muted">{info.platform === 'android'
            ? 'Install the APK, open the ReyDesk agent, and enter this page\u2019s 12-digit code to enroll. You will be prompted to allow screen capture and accessibility when your technician connects.'
            : `Detected device: ${info.platform === 'macos' ? 'MacBook/macOS' : 'Windows'}. The helper is portable and runs only for this support session.`}</span></div> : <div className="connect-download"><strong>{info.platform === 'ios' || info.platform === 'ipados' || info.platform === 'android' ? 'Use browser-based support on this device' : 'Helper download unavailable'}</strong><span className="muted">{info.platform === 'ios' || info.platform === 'ipados' || info.platform === 'android'
                  ? (info.platform === 'android'
                    ? 'Keep this page open to approve access, chat, and share context with your technician. If your IT team has distributed the ReyDesk Android agent, install it and enter this page\u2019s 12-digit code to enroll.'
                    : 'Mobile operating systems do not permit a general unattended remote-control agent. Keep this page open to approve access, chat, and share context with your technician.')
                  : 'A signed helper for this platform is not configured yet. Ask your technician for a supported package.'}</span></div>}
          {canChat ? <section className="connect-chat-card">
            <div className="connect-live-header"><div><strong>Support conversation</strong><span className="muted">Technician messages appear here while they work.</span></div><span className="status-pill status-active">Connected</span></div>
            <div className="chat-log connect-chat-log" ref={chatLogRef}>
              {chatMessages.length === 0 ? <span className="muted">No messages yet. You can send a message when you need attention.</span> : chatMessages.map((message, index) => {
                const url = firstUrl(message.body)
                const fromUser = message.sender_type !== 'technician'
                return (
                  <div className={`connect-chat-message ${fromUser ? 'from-user' : 'from-technician'}`} key={`${message.created_at}-${index}`}>
                    <span className="muted">{fromUser ? 'You' : 'Technician'}</span>
                    {message.attachment?.kind === 'image' && message.attachment.dataUrl ? <img className="chat-attachment-image" src={message.attachment.dataUrl} alt={message.attachment.name ?? 'Shared image'} /> : null}
                    {message.body ? <p className="chat-body">{linkifyText(message.body)}</p> : null}
                    {url ? <a className="chat-url-preview" href={url} target="_blank" rel="noopener noreferrer">
                      <img className="chat-url-favicon" src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=64`} alt="" />
                      <span className="chat-url-text"><strong>{hostOf(url)}</strong><small>{url}</small></span>
                      <span className="chat-url-arrow">↗</span>
                    </a> : null}
                  </div>
                )
              })}
              {peerTyping ? <div className="chat-typing"><span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="muted">Technician is typing…</span></div> : null}
            </div>
            <div className="connect-chat-composer">
              <div className="chat-composer-row">
                <button type="button" className={`chat-tool-btn ${emojiOpen ? 'chat-tool-btn-active' : ''}`} title="Emoji" onClick={() => setEmojiOpen((open) => !open)}>😊</button>
                <textarea className="field-input chat-composer-input" value={chatDraft} onChange={(event) => {
                  setChatDraft(event.target.value)
                  if (event.target.value.trim()) {
                    sendTyping(true)
                    window.clearTimeout(typingTimerRef.current)
                    typingTimerRef.current = window.setTimeout(() => sendTyping(false), 2000)
                  }
                }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} placeholder="Message your technician…" rows={2} />
                <button className="btn btn-primary btn-sm chat-send-btn" onClick={() => void sendChat()} disabled={!chatDraft.trim()}>Send</button>
              </div>
              {emojiOpen ? <div className="chat-emoji-picker">{CHAT_EMOJI.map((emoji) => <button key={emoji} type="button" onClick={() => { setChatDraft((draft) => `${draft}${emoji}`); setEmojiOpen(false) }}>{emoji}</button>)}</div> : null}
              <div className="chat-composer-hint"><span className="muted">{chatStatus ?? 'Enter to send · Shift+Enter for a new line'}</span></div>
            </div>
          </section> : null}
          {consentState === 'granted' || info.state === 'active' ? <button className="btn btn-danger btn-block" onClick={() => void endConnection()} disabled={ending}>{ending ? 'Ending support…' : 'End support session'}</button> : null}
          <p className="muted">Your approval is recorded. ReyDesk shows what access was granted and when the session ends.</p>
        </div> : null}
      </div>
    </div>
  )
}
