import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Modal, PageHeader } from '../components/ui.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'

interface Member {
  membership_id: string
  user_id: string
  email: string
  name: string
  org_role: string
  status: string
  created_at: string
}

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'it_manager', label: 'IT Manager' },
  { value: 'service_desk_manager', label: 'Service Desk Manager' },
  { value: 'analyst', label: 'Analyst' },
  { value: 'desktop_engineer', label: 'Desktop Engineer' },
  { value: 'infrastructure_engineer', label: 'Infrastructure Engineer' },
  { value: 'security_analyst', label: 'Security Analyst' },
  { value: 'auditor', label: 'Auditor' },
  { value: 'end_user', label: 'End User' },
]

const ROLE_LABELS: Record<string, string> = Object.fromEntries(ROLES.map((r) => [r.value, r.label]))

export default function StaffPage() {
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('analyst')
  const [inviting, setInviting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const auth = useAuth()
  const myRole = auth.memberships.find((m) => m.tenant.id === auth.activeTenantId)?.orgRole
  const canManage = myRole === 'owner' || myRole === 'it_manager'

  const load = useCallback(async () => {
    try {
      const res = await api('/members') as { members: Member[] }
      setMembers(res.members)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const handleInvite = async (e: FormEvent) => {
    e.preventDefault()
    setInviting(true)
    setError(null)
    setNotice(null)
    try {
      await api('/members/invite', { method: 'POST', body: { email: inviteEmail, role: inviteRole } })
      setNotice(`Invitation sent to ${inviteEmail}`)
      setInviteEmail('')
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite')
    }
    setInviting(false)
  }

  const handleRoleChange = async (userId: string, newRole: string) => {
    try {
      await api(`/members/${userId}/role`, { method: 'PATCH', body: { role: newRole } })
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change role')
    }
  }

  const handleRemove = async (userId: string, name: string) => {
    if (!confirm(`Remove ${name} from this organization?`)) return
    try {
      await api(`/members/${userId}`, { method: 'DELETE' })
      void load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member')
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Staff"
        subtitle={`${members.length} member${members.length !== 1 ? 's' : ''} in this organization`}
      />

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      {/* Invite button */}
      {canManage && (
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-primary btn-sm" onClick={() => { setShowInvite(true); setInviteEmail(''); setInviteRole('analyst') }}>+ Invite member</button>
        </div>
      )}

      {/* Invite modal */}
      <Modal open={showInvite} onClose={() => { if (!inviting) setShowInvite(false) }} title="Invite a team member">
        <form onSubmit={handleInvite}>
          <div className="field" style={{ marginBottom: '1rem' }}>
            <label className="field-label" htmlFor="invite-email">Email address</label>
            <input
              className="field-input"
              id="invite-email"
              type="email"
              required
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="colleague@company.com"
            />
          </div>
          <div className="field" style={{ maxWidth: 220, marginBottom: '1rem' }}>
            <label className="field-label" htmlFor="invite-role">Role</label>
            <select
              className="field-input"
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              {ROLES.filter((r) => r.value !== 'owner').map((r) => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" type="button" onClick={() => setShowInvite(false)} disabled={inviting}>Cancel</button>
            <button className="btn btn-primary" type="submit" disabled={inviting}>
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Members table */}
      {loading ? (
        <span className="etch">Loading members…</span>
      ) : (
        <div className="device-table-wrap">
          <table className="device-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Joined</th>
                {canManage && <th style={{ width: 80 }}></th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.membership_id}>
                  <td style={{ fontWeight: 500 }}>{m.name || '—'}</td>
                  <td className="mono">{m.email}</td>
                  <td>
                    {canManage && m.org_role !== 'owner' ? (
                      <select
                        className="field-input select-sm"
                        value={m.org_role}
                        onChange={(e) => void handleRoleChange(m.user_id, e.target.value)}
                        style={{ width: 160 }}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="status-pill">{ROLE_LABELS[m.org_role] || m.org_role}</span>
                    )}
                  </td>
                  <td>
                    <span className={`status-pill status-${m.status === 'active' ? 'open' : 'new'}`}>
                      {m.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }} className="mono muted">
                    {new Date(m.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </td>
                  {canManage && (
                    <td style={{ textAlign: 'right' }}>
                      {m.org_role !== 'owner' && m.user_id !== auth.user?.id && (
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ color: 'var(--crit)', fontSize: 12 }}
                          onClick={() => void handleRemove(m.user_id, m.name)}
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  )
}
