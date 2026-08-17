import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { useAuth } from '../lib/auth.js'
import {
  approveGrant, checkinGrant, checkoutGrant, denyGrant,
  listGrants, requestGrant, revokeGrant,
  type Grant, type GrantPermission, type GrantScope, type GrantStatus,
} from '../lib/grants.js'

const PERMISSIONS: Array<{ value: GrantPermission; label: string; desc: string }> = [
  { value: 'remote.elevated', label: 'Elevated remote control', desc: 'Full admin access to a device — screen, keyboard, file system, and terminal.' },
  { value: 'remote.control', label: 'Remote control', desc: 'Screen sharing with input control (keyboard and mouse).' },
  { value: 'remote.attended', label: 'Attended access', desc: 'View the user\'s screen with their consent. No input control.' },
  { value: 'remote.unattended', label: 'Unattended access', desc: 'Connect to a device without user interaction. Agent must be enrolled.' },
  { value: 'remote.inspection', label: 'Device inspection', desc: 'Read-only access to device inventory, processes, and health data.' },
  { value: 'script.execute', label: 'Script execution', desc: 'Run approved scripts on target devices.' },
]

const SCOPES: Array<{ value: GrantScope; label: string; desc: string }> = [
  { value: 'tenant', label: 'All devices', desc: 'Access across the entire organization.' },
  { value: 'device_group', label: 'Device group', desc: 'Access to a specific group of devices.' },
  { value: 'device', label: 'Single device', desc: 'Access to one specific device.' },
]

const STATUS_CONFIG: Record<string, { color: string; bg: string; icon: string }> = {
  pending: { color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.12)', icon: '⏳' },
  approved: { color: '#3b82f6', bg: 'rgba(59, 130, 246, 0.12)', icon: '✓' },
  active: { color: '#10b981', bg: 'rgba(16, 185, 129, 0.12)', icon: '⚡' },
  denied: { color: '#ef4444', bg: 'rgba(239, 68, 68, 0.12)', icon: '✕' },
  revoked: { color: '#6b7280', bg: 'rgba(107, 114, 128, 0.12)', icon: '⊘' },
  expired: { color: '#9ca3af', bg: 'rgba(156, 163, 175, 0.12)', icon: '⏰' },
}

function timeLeft(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now()
  if (diff <= 0) return 'Expired'
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m left`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m left`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h left`
}

export default function GrantsPage() {
  const auth = useAuth()
  const perms = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canApprove = perms.has('grant.approve')
  const canRequest = perms.has('grant.request')
  const userId = auth.user?.id

  const [grants, setGrants] = useState<Grant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // grant id being acted on

  // Request form
  const [showRequest, setShowRequest] = useState(false)
  const [reqPermission, setReqPermission] = useState<GrantPermission>('remote.elevated')
  const [reqScope, setReqScope] = useState<GrantScope>('tenant')
  const [reqScopeId, setReqScopeId] = useState('')
  const [reqReason, setReqReason] = useState('')
  const [reqExpires, setReqExpires] = useState('')
  const [reqBusy, setReqBusy] = useState(false)

  // Filters
  const [tab, setTab] = useState<'active' | 'pending' | 'history'>('active')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await listGrants()
      setGrants(res.grants)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load grants')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id)
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    }
    setBusy(null)
  }

  const handleSubmitRequest = async (e: React.FormEvent) => {
    e.preventDefault()
    if (reqBusy || !reqReason.trim() || !reqExpires) return
    setReqBusy(true)
    setError(null)
    try {
      await requestGrant({
        permission: reqPermission,
        scopeType: reqScope,
        scopeId: reqScope !== 'tenant' ? reqScopeId : undefined,
        reason: reqReason,
        expiresAt: new Date(reqExpires).toISOString(),
      })
      setShowRequest(false)
      setReqReason('')
      setReqExpires('')
      setReqScopeId('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    }
    setReqBusy(false)
  }

  // Categorize grants
  const activeGrants = grants.filter((g) => g.effective_status === 'active' || g.status === 'approved')
  const pendingGrants = grants.filter((g) => g.status === 'pending')
  const historyGrants = grants.filter((g) => ['denied', 'revoked', 'expired'].includes(g.status) || g.effective_status === 'expired')

  const myActiveGrants = activeGrants.filter((g) => g.subject_id === userId)
  const myPendingGrants = pendingGrants.filter((g) => g.subject_id === userId)
  const pendingApprovals = canApprove ? pendingGrants : []

  const displayGrants = tab === 'active' ? activeGrants : tab === 'pending' ? pendingGrants : historyGrants

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1 className="page-title">Privileged Access</h1>
          <p className="page-subtitle">Request, approve, and manage time-boxed elevated access to devices.</p>
        </div>
        {canRequest && (
          <button className="btn btn-primary" onClick={() => { setShowRequest(true); setError(null) }}>
            + Request access
          </button>
        )}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {/* Summary cards */}
      <div className="grant-summary-row">
        <div className="grant-summary-card">
          <span className="grant-summary-icon" style={{ color: '#10b981' }}>⚡</span>
          <div>
            <span className="grant-summary-value">{myActiveGrants.length}</span>
            <span className="grant-summary-label">Active grants</span>
          </div>
        </div>
        <div className="grant-summary-card">
          <span className="grant-summary-icon" style={{ color: '#f59e0b' }}>⏳</span>
          <div>
            <span className="grant-summary-value">{myPendingGrants.length}</span>
            <span className="grant-summary-label">My pending requests</span>
          </div>
        </div>
        {canApprove && (
          <div className="grant-summary-card grant-summary-highlight">
            <span className="grant-summary-icon" style={{ color: '#3b82f6' }}>🔔</span>
            <div>
              <span className="grant-summary-value">{pendingApprovals.length}</span>
              <span className="grant-summary-label">Awaiting your approval</span>
            </div>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="tabs" role="tablist">
        <button role="tab" className={`tab${tab === 'active' ? ' active' : ''}`} onClick={() => setTab('active')}>
          Active ({activeGrants.length})
        </button>
        <button role="tab" className={`tab${tab === 'pending' ? ' active' : ''}`} onClick={() => setTab('pending')}>
          Pending ({pendingGrants.length})
        </button>
        <button role="tab" className={`tab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
          History ({historyGrants.length})
        </button>
      </div>

      {/* Grants list */}
      {loading ? (
        <div className="dash-loading"><div className="loading-spinner" /><p>Loading grants…</p></div>
      ) : displayGrants.length === 0 ? (
        <div className="empty-state">
          {tab === 'active' && 'No active grants. Request access to get started.'}
          {tab === 'pending' && 'No pending requests.'}
          {tab === 'history' && 'No past grants yet.'}
        </div>
      ) : (
        <div className="grant-list">
          {displayGrants.map((g) => {
            const cfg = STATUS_CONFIG[g.effective_status] || STATUS_CONFIG[g.status] || STATUS_CONFIG.pending
            const perm = PERMISSIONS.find((p) => p.value === g.permission)
            const isMine = g.subject_id === userId
            const canAct = canApprove && g.status === 'pending'
            const isCheckedOut = g.status === 'approved' && g.checked_out_at && !g.checked_in_at

            return (
              <div key={g.id} className={`grant-card ${isCheckedOut ? 'grant-active' : ''}`}>
                <div className="grant-card-header">
                  <div className="grant-card-status" style={{ background: cfg.bg, color: cfg.color }}>
                    <span>{cfg.icon}</span>
                    <span>{g.effective_status}</span>
                  </div>
                  <span className="grant-card-time">{timeLeft(g.expires_at)}</span>
                </div>

                <div className="grant-card-body">
                  <h3 className="grant-card-permission">{perm?.label || g.permission}</h3>
                  <p className="grant-card-desc">{perm?.desc}</p>

                  <div className="grant-card-meta">
                    <div className="grant-meta-row">
                      <span className="grant-meta-label">Scope</span>
                      <span className="grant-meta-value">{g.scope_type === 'tenant' ? 'All devices' : g.scope_type.replace('_', ' ')}</span>
                    </div>
                    <div className="grant-meta-row">
                      <span className="grant-meta-label">Requested by</span>
                      <span className="grant-meta-value">{g.requested_by_name || g.grantee_name || 'Unknown'}</span>
                    </div>
                    <div className="grant-meta-row">
                      <span className="grant-meta-label">Reason</span>
                      <span className="grant-meta-value">{g.reason || '—'}</span>
                    </div>
                    <div className="grant-meta-row">
                      <span className="grant-meta-label">Expires</span>
                      <span className="grant-meta-value">{new Date(g.expires_at).toLocaleString()}</span>
                    </div>
                    {g.checked_out_at && (
                      <div className="grant-meta-row">
                        <span className="grant-meta-label">Checked out</span>
                        <span className="grant-meta-value">{new Date(g.checked_out_at).toLocaleString()}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="grant-card-actions">
                  {canAct && (
                    <>
                      <button className="btn btn-primary btn-sm" disabled={busy === g.id} onClick={() => void act(g.id, () => approveGrant(g.id))}>
                        Approve
                      </button>
                      <button className="btn btn-ghost btn-sm btn-danger" disabled={busy === g.id} onClick={() => void act(g.id, () => denyGrant(g.id))}>
                        Deny
                      </button>
                    </>
                  )}
                  {isMine && g.status === 'approved' && !isCheckedOut && (
                    <button className="btn btn-primary btn-sm" disabled={busy === g.id} onClick={() => void act(g.id, () => checkoutGrant(g.id))}>
                      Check out
                    </button>
                  )}
                  {isMine && isCheckedOut && (
                    <button className="btn btn-ghost btn-sm" disabled={busy === g.id} onClick={() => void act(g.id, () => checkinGrant(g.id))}>
                      Check in
                    </button>
                  )}
                  {canApprove && !['denied', 'revoked', 'expired'].includes(g.status) && (
                    <button className="btn btn-ghost btn-sm btn-danger" disabled={busy === g.id} onClick={() => void act(g.id, () => revokeGrant(g.id))}>
                      Revoke
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Request access modal */}
      {showRequest && (
        <div className="modal-backdrop" onClick={() => { if (!reqBusy) setShowRequest(false) }}>
          <div className="modal grant-request-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Request privileged access</h3>
            <p className="modal-desc">
              Describe what you need and why. An approver will review your request.
              Access is time-boxed and must be checked out before use.
            </p>

            <form onSubmit={(e) => void handleSubmitRequest(e)}>
              <div className="grant-form-section">
                <h4 className="grant-form-section-title">What access do you need?</h4>
                <div className="grant-permission-grid">
                  {PERMISSIONS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      className={`grant-permission-card ${reqPermission === p.value ? 'selected' : ''}`}
                      onClick={() => setReqPermission(p.value)}
                    >
                      <span className="grant-permission-name">{p.label}</span>
                      <span className="grant-permission-desc">{p.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grant-form-section">
                <h4 className="grant-form-section-title">Scope</h4>
                <div className="grant-scope-row">
                  {SCOPES.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`grant-scope-btn ${reqScope === s.value ? 'selected' : ''}`}
                      onClick={() => setReqScope(s.value)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                {reqScope !== 'tenant' && (
                  <input
                    className="field-input"
                    placeholder={reqScope === 'device' ? 'Device ID (UUID)' : 'Device group ID (UUID)'}
                    value={reqScopeId}
                    onChange={(e) => setReqScopeId(e.target.value)}
                    style={{ marginTop: '0.5rem' }}
                  />
                )}
              </div>

              <div className="grant-form-section">
                <h4 className="grant-form-section-title">When and why?</h4>
                <div className="form-row">
                  <div className="grant-form-group">
                    <label className="grant-form-label">Expires at</label>
                    <input className="field-input" type="datetime-local" value={reqExpires} onChange={(e) => setReqExpires(e.target.value)} required />
                  </div>
                </div>
                <div className="grant-form-group" style={{ marginTop: '0.5rem' }}>
                  <label className="grant-form-label">Reason (required)</label>
                  <textarea
                    className="field-input"
                    rows={3}
                    value={reqReason}
                    onChange={(e) => setReqReason(e.target.value)}
                    placeholder="Who, what, and why you need this access…"
                    required
                  />
                </div>
              </div>

              <div className="grant-form-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setShowRequest(false)} disabled={reqBusy}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={reqBusy || !reqReason.trim() || !reqExpires}>
                  {reqBusy ? 'Requesting…' : 'Submit request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </Shell>
  )
}
