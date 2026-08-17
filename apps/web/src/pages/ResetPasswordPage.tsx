import { useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api.js'
import { PasswordField } from '../components/PasswordField.js'

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  if (!token) {
    return (
      <div className="auth-screen">
        <div className="auth-panel">
          <div className="brand-row">
            <Link to="/" className="brand" style={{ textDecoration: 'none' }}>DeskOS</Link>
          </div>
          <h1 className="auth-title">Invalid reset link</h1>
          <p className="auth-sub">This password reset link is invalid or missing a token.</p>
          <div className="auth-alt">
            <Link to="/forgot-password">Request a new reset link</Link>
          </div>
        </div>
      </div>
    )
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 10) {
      setError('Password must be at least 10 characters')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await api('/auth/reset-password', { method: 'POST', body: { token, password } })
      setSubmitted(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    }
    setLoading(false)
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="brand-row">
          <Link to="/" className="brand" style={{ textDecoration: 'none' }}>DeskOS</Link>
        </div>

        {submitted ? (
          <>
            <h1 className="auth-title">Password updated</h1>
            <p className="auth-sub">
              Your password has been reset. You can now sign in with your new password.
            </p>
            <div className="auth-alt">
              <Link to="/login">Sign in →</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="auth-title">Set a new password</h1>
            <p className="auth-sub">Choose a strong password (at least 10 characters).</p>

            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <PasswordField
                label="New password"
                hint="At least 10 characters"
                className="field-input"
                id="reset-password"
                required
                minLength={10}
                maxLength={256}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
              />
              <PasswordField
                label="Confirm password"
                className="field-input"
                id="reset-confirm"
                required
                minLength={10}
                maxLength={256}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
                {loading ? 'Updating…' : 'Reset password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}
