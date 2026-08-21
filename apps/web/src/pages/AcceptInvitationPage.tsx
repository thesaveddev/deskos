import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Alert, BrandRow, Field, SubmitButton } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import { ApiError, api } from '../lib/api.js'

export default function AcceptInvitationPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const [password, setPassword] = useState('')
  const [requiresPassword, setRequiresPassword] = useState(false)
  const [acceptedEmail, setAcceptedEmail] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(token ? null : 'This invitation link is incomplete.')
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!token || busy) return
    if (requiresPassword && password.length < 10) {
      setError('Choose a password with at least 10 characters.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await api<{ ok: true; email: string }>('/auth/invitations/accept', {
        method: 'POST',
        auth: false,
        retryOn401: false,
        body: { token, ...(password ? { password } : {}) },
      })
      setAcceptedEmail(result.email)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invitation_password_required') {
        setRequiresPassword(true)
        setError('Create a password to finish setting up your ReyDesk account.')
      } else if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError('We could not accept this invitation. Please request a new link from your administrator.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <BrandRow />
        {acceptedEmail ? (
          <>
            <h1 className="auth-title">You’re in</h1>
            <p className="auth-sub">Your invitation was accepted for <strong>{acceptedEmail}</strong>. Sign in to open your workspace.</p>
            <button className="btn btn-primary btn-block" type="button" onClick={() => navigate('/login', { replace: true })}>Continue to sign in</button>
          </>
        ) : (
          <>
            <h1 className="auth-title">Join your ReyDesk workspace</h1>
            <p className="auth-sub">Accept the invitation from your organisation to join its support workspace.</p>
            {error ? <Alert kind="error">{error}</Alert> : null}
            <form onSubmit={submit} noValidate>
              {requiresPassword ? <PasswordField label="Create a password" hint="At least 10 characters." className="field-input" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={10} required autoFocus /> : null}
              <SubmitButton busy={busy}>{requiresPassword ? 'Create account and join' : 'Accept invitation'}</SubmitButton>
            </form>
          </>
        )}
        <div className="auth-alt"><Link to="/login">Back to sign in</Link></div>
      </div>
    </div>
  )
}
