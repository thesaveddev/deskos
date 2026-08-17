import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api.js'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      await api('/auth/forgot-password', { method: 'POST', body: { email } })
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
            <h1 className="auth-title">Check your email</h1>
            <p className="auth-sub">
              If an account exists with <strong>{email}</strong>, we've sent a password reset link. Check your inbox and follow the instructions.
            </p>
            <p className="auth-sub" style={{ fontSize: 12, color: 'var(--text-3)' }}>
              Didn't receive it? Check your spam folder, or try again in a few minutes.
            </p>
            <div className="auth-alt">
              <Link to="/login">← Back to sign in</Link>
            </div>
          </>
        ) : (
          <>
            <h1 className="auth-title">Reset your password</h1>
            <p className="auth-sub">
              Enter your email address and we'll send you a link to reset your password.
            </p>

            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={handleSubmit}>
              <div className="field">
                <label className="field-label" htmlFor="forgot-email">Email address</label>
                <input
                  className="field-input"
                  id="forgot-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoFocus
                />
              </div>
              <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
            </form>

            <div className="auth-alt">
              Remember your password? <Link to="/login">Sign in</Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
