import { useState, type FormEvent, useEffect } from 'react'
import { useAuth } from '../lib/auth.js'
import { ApiError, api } from '../lib/api.js'
import { PasswordField } from './PasswordField.js'

interface LockUser {
  id: string
  email: string
  name: string
}

interface LoginResponse {
  user: LockUser
  accessToken: string
  refreshToken: string
}

interface Props {
  user: LockUser
  onUnlock: () => void
  onGoToLogin?: () => void
}

export function LockScreen({ user, onUnlock, onGoToLogin }: Props) {
  const applySession = useAuth((state) => state.applySession)
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [requiresMfa, setRequiresMfa] = useState(false)
  const [useRecoveryCode, setUseRecoveryCode] = useState(false)
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMfaSetupRequired(false)

    try {
      const body = requiresMfa
        ? { email: user.email, password, mfaCode }
        : { email: user.email, password }
      const session = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body,
        auth: false,
        retryOn401: false,
      })

      // Login issues a new access/refresh-token pair. Store it before showing
      // the workspace again; otherwise an expired token leaves the user locked
      // out again as soon as the next protected request is made.
      await applySession(session)
      setPassword('')
      setMfaCode('')
      setRequiresMfa(false)
      setUseRecoveryCode(false)
      setMfaSetupRequired(false)
      onUnlock()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'mfa_required') {
        setRequiresMfa(true)
        setUseRecoveryCode(false)
        setError('Enter the authentication code from your authenticator app, or use a recovery code.')
      } else if (err instanceof ApiError && err.code === 'mfa_invalid') {
        setRequiresMfa(true)
        setError(useRecoveryCode ? 'That recovery code is not valid or has already been used.' : 'That authentication code is not valid. Please try again.')
        setMfaCode('')
      } else if (err instanceof ApiError && err.code === 'account_locked') {
        setError('This account is temporarily locked after too many failed attempts. Try again later.')
      } else if (err instanceof ApiError && err.code === 'mfa_setup_required') {
        setMfaSetupRequired(true)
        setRequiresMfa(false)
        setError('Your organisation requires MFA setup before this account can sign in.')
      } else if (err instanceof ApiError && err.status >= 500) {
        setError('ReyDesk could not finish unlocking your workspace. Please try again in a moment.')
      } else if (err instanceof ApiError && err.status === 0) {
        setError('Cannot reach ReyDesk right now. Check your connection and try again.')
      } else if (err instanceof ApiError) {
        setError(err.message || 'We could not unlock this workspace. Please try again.')
      } else {
        setError('Cannot reach ReyDesk right now. Check your connection and try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  const name = user.name || user.email
  const initials = name.charAt(0).toUpperCase()
  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const dateStr = time.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="lock-screen">
      <div className="lock-screen-time">{timeStr}</div>
      <div className="lock-screen-date">{dateStr}</div>

      <div className="lock-screen-card">
        <div className="lock-screen-avatar">{initials}</div>
        <div className="lock-screen-name">{name}</div>
        <div className="lock-screen-email">{user.email}</div>

        <form onSubmit={handleSubmit} className="lock-screen-form">
          {error && <div className="lock-screen-error" role="alert" aria-live="polite">{error}</div>}
          {mfaSetupRequired && onGoToLogin && (
            <button type="button" className="lock-screen-mfa-switch" onClick={onGoToLogin}>
              Open the full sign-in page to finish setup →
            </button>
          )}
          <div className="lock-screen-input-wrap">
            <button
              className="lock-screen-submit"
              type="submit"
              disabled={loading || (requiresMfa ? mfaCode.length < 6 : !password)}
              aria-label={requiresMfa ? 'Verify and unlock' : 'Unlock'}
            >
              {loading ? '…' : '→'}
            </button>
            {!requiresMfa ? (
              <PasswordField
                className="lock-screen-input"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                disabled={loading}
                autoComplete="current-password"
              />
            ) : (
              <input
                className="lock-screen-input"
                placeholder={useRecoveryCode ? 'Recovery code (for example, A1B2C-3D4E5)' : 'Authenticator code'}
                inputMode="text"
                autoComplete="one-time-code"
                value={mfaCode}
                onChange={(e) => setMfaCode(e.target.value.toUpperCase())}
                autoFocus
                disabled={loading}
                required
              />
            )}
          </div>
          <div className="lock-screen-hint">
            {requiresMfa
              ? useRecoveryCode
                ? 'Recovery codes are single-use. Enter one exactly as it was saved.'
                : 'Enter your authentication code to unlock this workspace.'
              : `Welcome back, ${name.split(' ')[0]}. Please enter your password to continue.`}
          </div>
          {requiresMfa ? (
            <button
              type="button"
              className="lock-screen-mfa-switch"
              onClick={() => {
                setUseRecoveryCode((current) => !current)
                setMfaCode('')
                setError(null)
              }}
              disabled={loading}
            >
              {useRecoveryCode ? 'Use an authenticator code instead' : 'Use a recovery code instead'}
            </button>
          ) : null}
        </form>
      </div>
    </div>
  )
}
