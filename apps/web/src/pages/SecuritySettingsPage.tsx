import { useCallback, useEffect, useState } from 'react'
import { Alert } from '../components/ui.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { listPasskeys, registerPasskey, removePasskey, type PasskeyCredential } from '../lib/webauthn.js'

type MfaPolicy = 'optional' | 'required' | 'admin_only'

function getMfaPolicyLabel(p: MfaPolicy): string {
  switch (p) {
    case 'optional': return 'Optional'
    case 'required': return 'Required for everyone'
    case 'admin_only': return 'Required for admins & owners'
  }
}

function getMfaPolicyDescription(p: MfaPolicy): string {
  switch (p) {
    case 'optional': return 'Users can choose to enable MFA on their accounts. No one is forced to set it up.'
    case 'required': return 'Every user in this organization must set up two-factor authentication before they can sign in.'
    case 'admin_only': return 'Admins and owners must have MFA enabled. Regular technicians can choose.'
  }
}

export default function SecuritySettingsPage() {
  const auth = useAuth()
  const [credentials, setCredentials] = useState<PasskeyCredential[] | null>(null)
  const [deviceName, setDeviceName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // MFA policy
  const [mfaPolicy, setMfaPolicy] = useState<MfaPolicy>('optional')
  const [policyLoading, setPolicyLoading] = useState(true)
  const [policySaving, setPolicySaving] = useState(false)
  const [policyNotice, setPolicyNotice] = useState<string | null>(null)
  const [usersWithMfa, setUsersWithMfa] = useState(0)
  const [usersTotal, setUsersTotal] = useState(0)
  const [usersNeedingSetup, setUsersNeedingSetup] = useState(0)

  const isOwnerOrAdmin = auth.memberships.some((m) => ['owner', 'admin'].includes(m.orgRole))

  const load = useCallback(async () => {
    try {
      setCredentials((await listPasskeys()).credentials)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load passkeys')
    }
  }, [])

  const loadMfaPolicy = useCallback(async () => {
    if (!isOwnerOrAdmin) return
    try {
      const res = await api('/tenant/mfa-policy') as { mfa_policy: MfaPolicy; users_with_mfa: number; users_total: number }
      setMfaPolicy(res.mfa_policy)
      setUsersWithMfa(res.users_with_mfa)
      setUsersTotal(res.users_total)
    } catch { /* ignore */ }
    setPolicyLoading(false)
  }, [isOwnerOrAdmin])

  useEffect(() => {
    void load()
    void loadMfaPolicy()
  }, [load, loadMfaPolicy])

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

  const saveMfaPolicy = async (policy: MfaPolicy) => {
    setPolicySaving(true)
    setPolicyNotice(null)
    setError(null)
    try {
      const res = await api('/tenant/mfa-policy', {
        method: 'PATCH',
        body: { mfa_policy: policy },
      }) as { users_needing_setup: number; users_with_mfa: number; users_total: number }
      setMfaPolicy(policy)
      setUsersWithMfa(res.users_with_mfa)
      setUsersTotal(res.users_total)
      setUsersNeedingSetup(res.users_needing_setup)
      if (res.users_needing_setup > 0) {
        setPolicyNotice(`Policy updated. ${res.users_needing_setup} user(s) will need to set up MFA before their next sign-in.`)
      } else {
        setPolicyNotice('MFA policy updated successfully.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update MFA policy')
    }
    setPolicySaving(false)
  }

  return (
    <div className="form-panel">
      {/* ── Org MFA Policy (admin/owner only) ── */}
      {isOwnerOrAdmin && (
        <div style={{ marginBottom: 32 }}>
          <h2 className="channel-form-title">Organization MFA Policy</h2>
          <p className="muted" style={{ marginBottom: 16 }}>
            Control whether two-factor authentication is required for users in this organization.
          </p>

          {policyNotice ? <Alert kind="info">{policyNotice}</Alert> : null}

          <div className="mfa-policy-options">
            {(['optional', 'admin_only', 'required'] as MfaPolicy[]).map((policy) => (
              <button
                key={policy}
                className={`mfa-policy-card${mfaPolicy === policy ? ' active' : ''}`}
                onClick={() => void saveMfaPolicy(policy)}
                disabled={policySaving}
              >
                <div className="mfa-policy-header">
                  <span className="mfa-policy-radio">{mfaPolicy === policy ? '●' : '○'}</span>
                  <span className="mfa-policy-name">{getMfaPolicyLabel(policy)}</span>
                </div>
                <p className="mfa-policy-desc">{getMfaPolicyDescription(policy)}</p>
              </button>
            ))}
          </div>

          <div className="mfa-policy-stats">
            <span className="mfa-stat">
              <span className="mfa-stat-num">{usersWithMfa}</span> of {usersTotal} users have MFA enabled
            </span>
            {mfaPolicy !== 'optional' && usersNeedingSetup > 0 && (
              <span className="mfa-stat mfa-stat-warn">
                ⚠ {usersNeedingSetup} user(s) will be blocked until they set up MFA
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Personal Passkeys ── */}
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
