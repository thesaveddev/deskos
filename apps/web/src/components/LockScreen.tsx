import { useState, type FormEvent, useEffect } from 'react'
import { useAuth } from '../lib/auth.js'
import { api } from '../lib/api.js'
import { PasswordField } from './PasswordField.js'

interface Props {
  onUnlock: () => void
}

export function LockScreen({ onUnlock }: Props) {
  const user = useAuth((s) => s.user)
  const [password, setPassword] = useState('')
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
    try {
      await api('/auth/login', {
        method: 'POST',
        body: { email: user?.email || '', password },
      })
      setPassword('')
      onUnlock()
    } catch {
      setError('Incorrect password. Please try again.')
      setPassword('')
    }
    setLoading(false)
  }

  const name = user?.name || user?.email || 'User'
  const initials = name.charAt(0).toUpperCase()
  const timeStr = time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const dateStr = time.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  return (
    <div className="lock-screen">
      <div className="lock-screen-time">{timeStr}</div>
      <div className="lock-screen-date">{dateStr}</div>

      <div className="lock-screen-card">
        <div className="lock-screen-avatar">
          {initials}
        </div>
        <div className="lock-screen-name">{name}</div>
        <div className="lock-screen-email">{user?.email}</div>

        <form onSubmit={handleSubmit} className="lock-screen-form">
          {error && <div className="lock-screen-error">{error}</div>}
          <PasswordField
            className="lock-screen-input"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            disabled={loading}
          />
          <button className="lock-screen-submit" type="submit" disabled={loading || !password}>
            →
          </button>
          <div className="lock-screen-hint">
            Welcome back, {name.split(' ')[0]}. Please enter your password to continue.
          </div>
        </form>
      </div>
    </div>
  )
}
