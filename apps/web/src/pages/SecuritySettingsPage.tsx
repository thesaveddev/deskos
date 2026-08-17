import { useCallback, useEffect, useState } from 'react'
import { Alert } from '../components/ui.js'
import { listPasskeys, registerPasskey, removePasskey, type PasskeyCredential } from '../lib/webauthn.js'

export default function SecuritySettingsPage() {
  const [credentials, setCredentials] = useState<PasskeyCredential[] | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setCredentials((await listPasskeys()).credentials)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load passkeys')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const register = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await registerPasskey(deviceName.trim() || undefined)
      setNotice('Passkey registered.')
      setDeviceName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey registration failed')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (credential: PasskeyCredential) => {
    if (!confirm(`Remove passkey "${credential.device_name || 'unnamed'}"?`)) return
    setError(null)
    try {
      await removePasskey(credential.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove passkey')
    }
  }

  return (
    <div className="form-panel">
      <h2 className="channel-form-title">Passkeys</h2>
      <p className="muted" style={{ marginBottom: 16 }}>
        Register a passkey — a security key, Windows Hello, Touch ID, or your phone — as a second sign-in factor.
      </p>
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}
      <div className="form-row">
        <input
          className="field-input"
          placeholder="Device name (optional)"
          value={deviceName}
          onChange={(e) => setDeviceName(e.target.value)}
        />
        <button className="btn btn-primary" disabled={busy} onClick={() => void register()}>
          {busy ? 'Waiting for authenticator…' : 'Register passkey'}
        </button>
      </div>

      <h3 className="channel-title">Registered passkeys</h3>
      {credentials === null ? (
        <span className="etch">Loading passkeys…</span>
      ) : credentials.length === 0 ? (
        <p className="muted">No passkeys registered yet.</p>
      ) : (
        <ul className="channel-list">
          {credentials.map((c) => (
            <li key={c.id} className="channel-card">
              <div className="channel-main">
                <span className="channel-name">{c.device_name || 'Passkey'}</span>
                <span className="channel-meta mono">
                  added {new Date(c.created_at).toLocaleDateString()}
                  {c.last_used_at ? ` · last used ${new Date(c.last_used_at).toLocaleString()}` : ''}
                </span>
              </div>
              <div className="channel-actions">
                <button className="btn btn-ghost btn-sm" onClick={() => void remove(c)}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
