import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { Alert, BrandRow, Field, SubmitButton } from '../components/ui.js'
import { PasswordField } from '../components/PasswordField.js'
import { api, ApiError } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

interface SignupResponse {
  user: { id: string; email: string; name: string }
  tenant: { id: string; slug: string }
  accessToken: string
  refreshToken: string
}

export default function SignupPage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [tenantName, setTenantName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (auth.status === 'authed') return <Navigate to="/" replace />

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (password.length < 10) {
      setError('Password must be at least 10 characters.')
      return
    }
    setBusy(true)
    try {
      const res = await api<SignupResponse>('/auth/signup', {
        method: 'POST',
        body: { name, email, password, tenantName },
        auth: false,
        retryOn401: false,
      })
      await auth.applySession(res)
      navigate('/', { replace: true })
    } catch (err) {
      let msg = 'Signup failed. Please try again.'
      if (err instanceof ApiError) {
        if (err.code === 'email_taken') msg = 'An account with this email already exists. Try signing in instead.'
        else if (err.status === 409) msg = 'An account with this email already exists.'
        else if (err.status === 429) msg = 'Too many attempts. Please wait a moment.'
        else msg = err.message || msg
      } else if (err instanceof Error) {
        msg = err.message || msg
      }
      setError(msg)
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <BrandRow />
        <h1 className="auth-title">Create your organisation</h1>
        <p className="auth-sub">Start a ReyDesk workspace — you will be the owner.</p>

        {error ? <Alert kind="error">{error}</Alert> : null}

        <form onSubmit={submit} noValidate>
          <Field label="Organisation name">
            <input
              className="field-input"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              placeholder="Acme IT"
              required
              autoFocus
            />
          </Field>
          <Field label="Your name">
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              required
            />
          </Field>
          <Field label="Email">
            <input
              className="field-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
            />
          </Field>
          <PasswordField
            label="Password"
            hint="At least 10 characters."
            className="field-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={10}
            required
          />
          <SubmitButton busy={busy}>Create workspace</SubmitButton>
        </form>

        <div className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </div>
    </div>
  )
}
