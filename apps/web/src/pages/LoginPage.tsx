import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Alert, BrandRow, Field, SubmitButton } from '../components/ui.js'
import { ApiError } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'
import { assertPasskey } from '../lib/webauthn.js'

interface LoginResponse {
  user: { id: string; email: string; name: string }
  accessToken: string
  refreshToken: string
}

export default function LoginPage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [phase, setPhase] = useState<'credentials' | 'mfa'>('credentials')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (auth.status === 'authed') return <Navigate to="/" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const body =
        phase === 'mfa'
          ? { email, password, mfaCode }
          : { email, password }
      const res = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body,
        auth: false,
        retryOn401: false,
      })
      await auth.applySession(res)
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setPhase('mfa')
        setBusy(false)
        return
      }
      setError(err instanceof Error ? err.message : 'Sign in failed')
      setBusy(false)
    }
  }

  const signInWithPasskey = async () => {
    if (!email || !password || busy) return
    setError(null)
    setBusy(true)
    try {
      const res = await assertPasskey(email, password)
      if (!('accessToken' in res)) {
        setError('No passkey is registered for this account. Use password sign-in instead.')
        setBusy(false)
        return
      }
      await auth.applySession(res)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey sign-in failed')
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <BrandRow />
        {phase === 'credentials' ? (
          <>
            <h1 className="auth-title">Sign in</h1>
            <p className="auth-sub">Your technician workspace awaits.</p>
          </>
        ) : (
          <>
            <h1 className="auth-title">Two-factor code</h1>
            <p className="auth-sub">Enter the 6-digit code from your authenticator app.</p>
          </>
        )}

        {error ? <Alert kind="error">{error}</Alert> : null}

        <form onSubmit={submit} noValidate>
          {phase === 'credentials' ? (
            <>
              <Field label="Email">
                <input
                  className="field-input"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </Field>
              <Field label="Password">
                <input
                  className="field-input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <div style={{ textAlign: 'right', marginTop: 4 }}>
                  <Link to="/forgot-password" style={{ fontSize: 12, color: 'var(--info)' }}>Forgot password?</Link>
                </div>
              </Field>
            </>
          ) : (
            <Field label="Authentication code">
              <input
                className="field-input"
                inputMode="numeric"
                pattern="\d{6,8}"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </Field>
          )}
          <SubmitButton busy={busy}>
            {phase === 'credentials' ? 'Sign in' : 'Verify'}
          </SubmitButton>
        </form>

        {phase === 'credentials' ? (
          <button
            className="btn btn-ghost btn-block"
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={() => void signInWithPasskey()}
          >
            Sign in with passkey
          </button>
        ) : null}

        <div className="auth-alt">
          New organisation? <Link to="/signup">Create one</Link> · <Link to="/">Back to site</Link>
        </div>
      </div>
    </div>
  )
}
