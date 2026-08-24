import { useEffect, useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, BrandRow, Field, SubmitButton } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import { ApiError, api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { assertPasskey } from '../lib/webauthn.js'
import { MfaQrCode } from '../components/MfaQrCode.js'

interface LoginResponse {
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
  tenant?: { id: string; slug: string }
}

type Phase = 'credentials' | 'mfa' | 'magic_sent' | 'magic_mfa' | 'setup' | 'recovery'

export default function LoginPage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next')
  const signInDestination = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'
  const initialMagicToken = searchParams.get('magic_token')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [magicEmail, setMagicEmail] = useState('')
  const [magicToken, setMagicToken] = useState<string | null>(initialMagicToken)
  const [phase, setPhase] = useState<Phase>(initialMagicToken ? 'magic_mfa' : 'credentials')
  const [setupToken, setSetupToken] = useState<string | null>(null)
  const [setupSecret, setSetupSecret] = useState<string | null>(null)
  const [setupUri, setSetupUri] = useState<string | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [pendingSession, setPendingSession] = useState<LoginResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const requestMagicLink = async () => {
    const requestedEmail = email.trim() || magicEmail.trim()
    if (!requestedEmail || busy) {
      setError('Enter your email address first.')
      return
    }
    setBusy(true); setError(null)
    try {
      await api('/auth/magic-link/request', { method: 'POST', auth: false, retryOn401: false, body: { email: requestedEmail } })
      setMagicEmail(requestedEmail)
      setPhase('magic_sent')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not request a sign-in link. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const verifyMagicLink = async (token: string, code?: string) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const result = await api<LoginResponse>('/auth/magic-link/verify', { method: 'POST', auth: false, retryOn401: false, body: { token, ...(code ? { mfaCode: code } : {}) } })
      await auth.applySession(result)
      if (result.tenant?.id) auth.switchTenant(result.tenant.id)
      navigate(signInDestination, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'magic_mfa_required') {
        const challenge = typeof err.details?.challenge_token === 'string' ? err.details.challenge_token : token
        setMagicToken(challenge)
        if (typeof err.details?.email === 'string') setMagicEmail(err.details.email)
        setMfaCode('')
        setPhase('magic_mfa')
      } else if (err instanceof ApiError && err.code === 'magic_link_expired') {
        setMagicToken(null)
        setPhase('credentials')
        setError('This sign-in link has expired or was already used. Request a new one.')
      } else {
        setError(err instanceof ApiError ? err.message : 'This sign-in link could not be verified.')
      }
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialMagicToken) void verifyMagicLink(initialMagicToken)
    // The URL token is intentionally handled once when the login page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMagicToken])

  if (auth.status === 'authed') return <Navigate to={signInDestination} replace />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null); setBusy(true)
    try {
      const body = phase === 'mfa' ? { email, password, mfaCode } : { email, password }
      const result = await api<LoginResponse>('/auth/login', { method: 'POST', body, auth: false, retryOn401: false })
      await auth.applySession(result)
      navigate(signInDestination, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setPhase('mfa'); setBusy(false); return
      }
      if (err instanceof ApiError && err.code === 'mfa_setup_required') {
        const token = typeof err.details?.setup_token === 'string' ? err.details.setup_token : null
        if (!token) { setError('MFA setup could not be started. Please sign in again.'); setBusy(false); return }
        try {
          const setup = await api<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup/begin', { method: 'POST', auth: false, retryOn401: false, body: { setupToken: token } })
          setSetupToken(token); setSetupSecret(setup.secret); setSetupUri(setup.otpauthUrl); setPhase('setup')
        } catch (setupError) { setError(setupError instanceof Error ? setupError.message : 'Could not start MFA setup') }
        setBusy(false); return
      }
      let message = 'Sign in failed. Please try again.'
      if (err instanceof ApiError) {
        if (err.code === 'invalid_credentials') message = 'Incorrect email or password. Please check and try again.'
        else if (err.code === 'account_locked') message = 'Account temporarily locked due to too many failed attempts. Try again in 15 minutes.'
        else if (err.code === 'mfa_invalid') message = 'Invalid authenticator or recovery code. Please try again.'
        else if (err.code === 'validation_error') {
          const validation = err.message.toLowerCase()
          message = validation.includes('email') && validation.includes('password')
            ? 'Enter a valid email address and your password.'
            : validation.includes('email')
              ? 'Enter a valid email address.'
              : validation.includes('password')
                ? 'Enter your password.'
                : 'Please check your details and try again.'
        }
        else if (err.code === 'mfa_setup_expired') message = 'Your MFA setup link expired. Sign in again to start a new setup.'
        else if (err.status === 429) message = 'Too many attempts. Please wait a moment and try again.'
        else if (err.status === 500) message = 'Server error. Please try again in a moment.'
        else if (err.status === 0) message = 'Cannot reach the server. Check your connection.'
        else message = err.message || message
      } else if (err instanceof Error) message = err.message.includes('fetch') ? 'Cannot reach the server. Check your connection.' : err.message || message
      setError(message); setBusy(false)
    }
  }

  const completeSetup = async (event: FormEvent) => {
    event.preventDefault()
    if (!setupToken || mfaCode.length !== 6 || busy) return
    setBusy(true); setError(null)
    try {
      const result = await api<LoginResponse & { recoveryCodes: string[] }>('/auth/mfa/setup/complete', { method: 'POST', auth: false, retryOn401: false, body: { setupToken, code: mfaCode } })
      setRecoveryCodes(result.recoveryCodes); setPendingSession(result); setMfaCode(''); setPhase('recovery')
    } catch (err) { setError(err instanceof ApiError ? err.message : 'The code could not be verified') }
    finally { setBusy(false) }
  }

  const finishSetup = async () => {
    if (!pendingSession || busy) return
    setBusy(true)
    setError(null)
    try {
      await auth.applySession(pendingSession)
      navigate(signInDestination, { replace: true })
    } catch (err) {
      // The setup transaction has already completed but keep the issued session
      // and give the user a retry instead of sending them back to credentials.
      setError(err instanceof ApiError
        ? `MFA is enabled, but ReyDesk could not open the dashboard: ${err.message}`
        : 'MFA is enabled, but the dashboard could not be opened. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  const copyRecoveryCodes = async () => {
    try { await navigator.clipboard.writeText(recoveryCodes.join('\n')) } catch { setError('Copy failed. Select the codes manually and save them securely.') }
  }

  const signInWithPasskey = async () => {
    if (!email || !password || busy) return
    setError(null); setBusy(true)
    try {
      const result = await assertPasskey(email, password)
      if (!('accessToken' in result)) { setError('No passkey is registered for this account. Use password sign-in instead.'); return }
      await auth.applySession(result); navigate(signInDestination, { replace: true })
    } catch (err) { setError(err instanceof Error ? err.message : 'Passkey sign-in failed') }
    finally { setBusy(false) }
  }

  return <div className="auth-screen"><div className="auth-panel auth-mfa-panel">
    <BrandRow />
    {phase === 'credentials' && <><h1 className="auth-title">Sign in</h1><p className="auth-sub">Your technician workspace awaits.</p></>}
    {phase === 'mfa' && <><h1 className="auth-title">Two-factor code</h1><p className="auth-sub">Enter your authenticator code or an unused recovery code.</p></>}
    {phase === 'magic_sent' && <><h1 className="auth-title">Check your email</h1><p className="auth-sub">If an eligible ReyDesk account exists for <strong>{magicEmail}</strong>, we sent a one-time sign-in link.</p></>}
    {phase === 'magic_mfa' && <><h1 className="auth-title">Confirm your identity</h1><p className="auth-sub">Your sign-in link is valid. Enter your authenticator or recovery code to continue.</p></>}
    {phase === 'setup' && <><h1 className="auth-title">Set up MFA to continue</h1><p className="auth-sub">Your organization requires two-factor authentication. Finish this one-time setup before accessing ReyDesk.</p></>}
    {phase === 'recovery' && <><h1 className="auth-title">Save your recovery codes</h1><p className="auth-sub">These codes are the fallback if you lose your authenticator. Each code works once.</p></>}
    {error ? <Alert kind="error">{error}</Alert> : null}

    {phase === 'credentials' && <><form onSubmit={submit} noValidate><Field label="Email"><input className="field-input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field><PasswordField label="Password" className="field-input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /><div style={{ textAlign: 'right', marginTop: 4 }}><Link to="/forgot-password" style={{ fontSize: 12, color: 'var(--info)' }}>Forgot password?</Link></div><SubmitButton busy={busy}>Sign in</SubmitButton></form><div className="auth-divider"><span>or</span></div><button className="btn btn-ghost btn-block" type="button" onClick={() => void requestMagicLink()} disabled={busy}>Email me a sign-in link</button><p className="field-hint" style={{ textAlign: 'center' }}>Available when your organization allows magic-link sign-in.</p></>}
    {phase === 'mfa' && <form onSubmit={submit} noValidate><Field label="Authenticator or recovery code"><input className="field-input" inputMode="text" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} required autoFocus /></Field><SubmitButton busy={busy}>Verify</SubmitButton></form>}
    {phase === 'magic_sent' && <div className="auth-magic-sent"><p>Open the email on this device and select <strong>Sign in to ReyDesk</strong>. The link expires in 15 minutes and works once.</p><button className="btn btn-ghost btn-block" type="button" onClick={() => setPhase('credentials')}>Use password instead</button><button className="btn btn-ghost btn-block" type="button" onClick={() => void requestMagicLink()} disabled={busy}>Send another link</button></div>}
    {phase === 'magic_mfa' && <form onSubmit={(event) => { event.preventDefault(); if (magicToken) void verifyMagicLink(magicToken, mfaCode) }} noValidate><Field label="Authenticator or recovery code"><input className="field-input" inputMode="text" autoComplete="one-time-code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value.toUpperCase())} required autoFocus /></Field><SubmitButton busy={busy}>Verify and continue</SubmitButton><button className="btn btn-ghost btn-block" type="button" onClick={() => { setMagicToken(null); setMfaCode(''); setPhase('credentials') }} disabled={busy}>Use password instead</button></form>}
    {phase === 'setup' && <form onSubmit={completeSetup} className="auth-mfa-setup"><div className="auth-instructions"><strong>1. Install an authenticator app</strong><span>Use Microsoft Authenticator, Google Authenticator, 1Password, or another TOTP-compatible app.</span><strong>2. Add ReyDesk</strong><span>Scan this QR code, or enter the setup key manually if your authenticator cannot scan.</span>{setupUri ? <MfaQrCode value={setupUri} /> : null}<code className="auth-secret">{setupSecret}</code><details><summary>Show setup URI</summary><code className="auth-uri">{setupUri}</code></details><strong>3. Confirm the six-digit code</strong></div><Field label="Code from your authenticator"><input className="field-input" inputMode="numeric" pattern="\d{6}" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} required autoFocus /></Field><SubmitButton busy={busy}>Verify and continue</SubmitButton></form>}
    {phase === 'recovery' && <div className="auth-recovery"><div className="auth-recovery-grid">{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><div className="auth-recovery-actions"><button className="btn btn-ghost" onClick={() => void copyRecoveryCodes()}>Copy codes</button><button className="btn btn-primary" onClick={() => void finishSetup()} disabled={busy}>I saved my codes</button></div><p className="field-hint">ReyDesk stores only hashes of these codes. You cannot retrieve this list later; regenerate it after signing in if needed.</p></div>}
    {phase === 'credentials' && <button className="btn btn-ghost btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={() => void signInWithPasskey()}>Sign in with passkey</button>}
    {(phase === 'credentials' || phase === 'mfa' || phase === 'magic_sent' || phase === 'magic_mfa') && <div className="auth-alt">New organisation? <Link to="/signup">Create one</Link> · <Link to="/">Back to site</Link></div>}
  </div></div>
}
