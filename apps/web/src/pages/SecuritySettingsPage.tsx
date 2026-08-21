import { useCallback, useEffect, useState } from 'react'
import { Alert, useConfirm } from '../components/ui.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'
import { listPasskeys, registerPasskey, removePasskey, type PasskeyCredential } from '../lib/webauthn.js'
import { MfaQrCode } from '../components/MfaQrCode.js'

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */

type MfaPolicy = 'optional' | 'required' | 'admin_only'
type SecTab = 'policy' | 'users_mfa' | 'passkeys' | 'my_mfa' | 'my_passkeys'

interface Member {
  membership_id: string; user_id: string; email: string; name: string | null
  org_role: string; status: string; mfa_enabled: boolean; webauthn_enabled: boolean
}

interface OrgPasskey {
  credential_id: string; membership_id: string; device_name: string; created_at: string; last_used_at: string | null
  user_id: string; user_name: string | null; user_email: string
}

/* ═══════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════ */

const POLICY_OPTIONS: { value: MfaPolicy; label: string; desc: string; icon: string }[] = [
  { value: 'optional', label: 'Optional', desc: 'Users can choose to enable MFA. No one is forced.', icon: '○' },
  { value: 'admin_only', label: 'Required for Admins', desc: 'Admins and owners must enable MFA. Technicians can choose.', icon: '◐' },
  { value: 'required', label: 'Required for Everyone', desc: 'Every user must set up MFA before their next sign-in.', icon: '●' },
]

const ROLE_OPTIONS = [
  { value: 'it_manager', label: 'IT Manager' },
  { value: 'service_desk_manager', label: 'Service Desk Manager' },
  { value: 'analyst', label: 'Analyst' },
  { value: 'desktop_engineer', label: 'Desktop Engineer' },
  { value: 'infrastructure_engineer', label: 'Infrastructure Engineer' },
  { value: 'security_analyst', label: 'Security Analyst' },
  { value: 'auditor', label: 'Auditor' },
  { value: 'end_user', label: 'End User' },
]

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner', admin: 'Admin', manager: 'Manager',
  technician: 'Technician', analyst: 'Analyst', end_user: 'End User',
  it_manager: 'IT Manager', service_desk_manager: 'Service Desk Manager',
  desktop_engineer: 'Desktop Engineer', infrastructure_engineer: 'Infrastructure Engineer',
  security_analyst: 'Security Analyst', auditor: 'Auditor',
}

export default function SecuritySettingsPage() {
  const auth = useAuth()
  const isOwnerOrAdmin = auth.memberships.some(m => ['owner', 'it_manager', 'service_desk_manager'].includes(m.orgRole))
  const [tab, setTab] = useState<SecTab>(isOwnerOrAdmin ? 'policy' : 'my_passkeys')

  return (
    <div className="sec-page">
      <div className="sec-header">
        <h1 className="page-title">Security Settings</h1>
        <p className="sec-header-sub">Manage authentication, MFA policies, and passkeys for your organization</p>
      </div>

      {/* ── Tab Bar ── */}
      <div className="sec-tabs">
        <button className={`sec-tab ${tab === 'policy' ? 'active' : ''}`} onClick={() => setTab('policy')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          MFA Policy
        </button>
        {isOwnerOrAdmin && (
          <button className={`sec-tab ${tab === 'users_mfa' ? 'active' : ''}`} onClick={() => setTab('users_mfa')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Users & MFA
          </button>
        )}
        {isOwnerOrAdmin && (
          <button className={`sec-tab ${tab === 'passkeys' ? 'active' : ''}`} onClick={() => setTab('passkeys')}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            All Passkeys
          </button>
        )}
        <button className={`sec-tab ${tab === 'my_mfa' ? 'active' : ''}`} onClick={() => setTab('my_mfa')}>
          <Icon name="shield" size={16} />
          My MFA
        </button>
        <button className={`sec-tab ${tab === 'my_passkeys' ? 'active' : ''}`} onClick={() => setTab('my_passkeys')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          My Passkeys
        </button>
      </div>

      {tab === 'policy' && <PolicyTab />}
      {tab === 'users_mfa' && <UsersMfaTab />}
      {tab === 'passkeys' && <AllPasskeysTab />}
      {tab === 'my_mfa' && <MyMfaTab />}
      {tab === 'my_passkeys' && <MyPasskeysTab />}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Tab: Org MFA Policy
   ═══════════════════════════════════════════════════════════════ */

function PolicyTab() {
  const [policy, setPolicy] = useState<MfaPolicy>('optional')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState({ withMfa: 0, total: 0, needingSetup: 0 })
  const [magicLinks, setMagicLinks] = useState({ portal_enabled: true, staff_enabled: false })
  const [magicLoading, setMagicLoading] = useState(true)
  const [magicSaving, setMagicSaving] = useState(false)

  useEffect(() => {
    api('/tenant/mfa-policy')
      .then((res: any) => {
        setPolicy(res.mfa_policy)
        setStats({ withMfa: res.users_with_mfa, total: res.users_total, needingSetup: 0 })
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    api('/tenant/settings')
      .then((res: any) => {
        const configured = res.settings?.magic_links ?? {}
        setMagicLinks({
          portal_enabled: configured.portal_enabled !== false,
          staff_enabled: configured.staff_enabled === true,
        })
      })
      .catch(() => {})
      .finally(() => setMagicLoading(false))
  }, [])

  const saveMagicLinks = async (patch: Partial<typeof magicLinks>) => {
    const next = { ...magicLinks, ...patch }
    setMagicSaving(true); setError(null); setNotice(null)
    try {
      const response: any = await api('/tenant/settings', { method: 'PATCH', body: { magic_links: next } })
      const saved = response.settings?.magic_links ?? next
      setMagicLinks({ portal_enabled: saved.portal_enabled !== false, staff_enabled: saved.staff_enabled === true })
      setNotice('Magic-link settings updated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update magic-link settings')
    } finally {
      setMagicSaving(false)
    }
  }

  const save = async (p: MfaPolicy) => {
    setSaving(true); setError(null); setNotice(null)
    try {
      const res: any = await api('/tenant/mfa-policy', { method: 'PATCH', body: { mfa_policy: p } })
      setPolicy(p)
      setStats({ withMfa: res.users_with_mfa, total: res.users_total, needingSetup: res.users_needing_setup ?? 0 })
      setNotice(res.users_needing_setup > 0
        ? `Policy updated. ${res.users_needing_setup} user(s) will need to set up MFA before next sign-in.`
        : 'MFA policy updated successfully.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update policy')
    }
    setSaving(false)
  }

  if (loading) return <div className="sec-loading">Loading policy…</div>

  return (
    <div className="sec-section">
      <div className="sec-section-head">
        <div>
          <h2 className="sec-section-title">Organization MFA Policy</h2>
          <p className="sec-section-desc">Control whether two-factor authentication is required for users in this organization.</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <div className="sec-policy-grid">
        {POLICY_OPTIONS.map(opt => (
          <button key={opt.value} className={`sec-policy-card ${policy === opt.value ? 'active' : ''}`}
            onClick={() => void save(opt.value)} disabled={saving}>
            <div className="sec-policy-icon">{opt.icon}</div>
            <div className="sec-policy-info">
              <span className="sec-policy-name">{opt.label}</span>
              <span className="sec-policy-desc">{opt.desc}</span>
            </div>
            {policy === opt.value && <span className="sec-policy-check">✓</span>}
          </button>
        ))}
      </div>

      <div className="sec-stats-row">
        <div className="sec-stat">
          <span className="sec-stat-num">{stats.withMfa}</span>
          <span className="sec-stat-label">of {stats.total} users have MFA</span>
        </div>
        {policy !== 'optional' && stats.needingSetup > 0 && (
          <div className="sec-stat sec-stat-warn">
            <span className="sec-stat-num">⚠ {stats.needingSetup}</span>
            <span className="sec-stat-label">user(s) blocked until MFA set up</span>
          </div>
        )}
      </div>

      <div className="sec-info-box">
        <h4>How enforcement works</h4>
        <ul>
          <li><strong>Optional:</strong> Users can enable MFA in their Security settings. No one is forced.</li>
          <li><strong>Required for admins:</strong> Users with Admin or Owner roles must have MFA enabled. Technicians can choose.</li>
          <li><strong>Required for everyone:</strong> All users must set up TOTP or passkeys before they can sign in.</li>
        </ul>
      </div>

      <div className="sec-info-box sec-magic-links-box">
        <div className="sec-section-head">
          <div>
            <h4>Magic-link sign-in</h4>
            <p>Let users receive a one-time sign-in link by email. Links expire after 15 minutes and can only be used once.</p>
          </div>
          <span className="sec-policy-check">✉</span>
        </div>
        {magicLoading ? <div className="sec-loading">Loading magic-link settings…</div> : <div className="sec-policy-grid">
          <button type="button" className={`sec-policy-card ${magicLinks.portal_enabled ? 'active' : ''}`} onClick={() => void saveMagicLinks({ portal_enabled: !magicLinks.portal_enabled })} disabled={magicSaving}>
            <div className="sec-policy-icon">◉</div>
            <div className="sec-policy-info"><span className="sec-policy-name">Customer portal users</span><span className="sec-policy-desc">Enabled by default for end users submitting and tracking requests.</span></div>
            <span className="sec-policy-check">{magicLinks.portal_enabled ? 'On' : 'Off'}</span>
          </button>
          <button type="button" className={`sec-policy-card ${magicLinks.staff_enabled ? 'active' : ''}`} onClick={() => void saveMagicLinks({ staff_enabled: !magicLinks.staff_enabled })} disabled={magicSaving}>
            <div className="sec-policy-icon">◌</div>
            <div className="sec-policy-info"><span className="sec-policy-name">Normal staff</span><span className="sec-policy-desc">Optional opt-in. Administrators and technicians never bypass an enabled MFA factor.</span></div>
            <span className="sec-policy-check">{magicLinks.staff_enabled ? 'On' : 'Off'}</span>
          </button>
        </div>}
        <p className="field-hint">Magic links do not replace MFA. A user with MFA enabled must still provide an authenticator or recovery code after opening the link. Keep staff sign-in disabled unless your organization is comfortable with email-based authentication.</p>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Tab: Users & MFA Status
   ═══════════════════════════════════════════════════════════════ */

function UsersMfaTab() {
  const auth = useAuth()
  const confirm = useConfirm()
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'mfa_on' | 'mfa_off'>('all')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'invited' | 'disabled'>('all')
  const [actionBusy, setActionBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res: any = await api('/members')
      setMembers(res.members)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load members')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const resetMfa = async (m: Member) => {
    if (!await confirm(`Reset MFA for ${m.name || m.email}? They will need to set up MFA again.`, { title: 'Reset MFA', confirmLabel: 'Reset MFA', destructive: true })) return
    setActionBusy(m.membership_id); setError(null); setNotice(null)
    try {
      await api(`/members/${m.membership_id}/reset-mfa`, { method: 'POST' })
      setMembers(prev => prev.map(u => u.membership_id === m.membership_id ? { ...u, mfa_enabled: false } : u))
      setNotice(`MFA reset for ${m.name || m.email}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset MFA')
    }
    setActionBusy(null)
  }

  const resetPasskeys = async (m: Member) => {
    if (!await confirm(`Remove all passkeys for ${m.name || m.email}?`, { title: 'Remove passkeys', confirmLabel: 'Remove passkeys', destructive: true })) return
    setActionBusy(m.membership_id); setError(null); setNotice(null)
    try {
      await api(`/members/${m.membership_id}/reset-passkeys`, { method: 'POST' })
      setMembers(prev => prev.map(u => u.membership_id === m.membership_id ? { ...u, webauthn_enabled: false } : u))
      setNotice(`Passkeys removed for ${m.name || m.email}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove passkeys')
    }
    setActionBusy(null)
  }

  const updateMember = async (m: Member, patch: { orgRole?: string; status?: string }, message: string) => {
    setActionBusy(m.membership_id); setError(null); setNotice(null)
    try {
      await api(`/members/${m.membership_id}`, { method: 'PATCH', body: patch })
      setMembers(prev => prev.map(u => u.membership_id === m.membership_id ? { ...u, ...patch } : u))
      setNotice(message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update user')
    } finally {
      setActionBusy(null)
    }
  }

  const filtered = members.filter(m => {
    const normalized = search.trim().toLowerCase()
    const matchesSearch = !normalized || (m.name ?? '').toLowerCase().includes(normalized) || m.email.toLowerCase().includes(normalized)
    const matchesMfa = filter === 'all' || (filter === 'mfa_on' ? m.mfa_enabled : !m.mfa_enabled)
    const matchesStatus = statusFilter === 'all' || m.status === statusFilter
    return matchesSearch && matchesMfa && matchesStatus
  })

  const mfaOnCount = members.filter(m => m.mfa_enabled).length
  const mfaOffCount = members.length - mfaOnCount

  if (loading) return <div className="sec-loading">Loading users…</div>

  return (
    <div className="sec-section">
      <div className="sec-section-head">
        <div>
          <h2 className="sec-section-title">Users & MFA Status</h2>
          <p className="sec-section-desc">View and manage MFA for all users in your organization.</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <div className="sec-user-toolbar">
        <div className="sec-search-field">
          <Icon name="search" size={15} />
          <input className="field-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email…" aria-label="Search users" />
        </div>
        <select className="field-input sec-status-filter" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} aria-label="Filter users by status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="invited">Invited</option>
          <option value="disabled">Disabled</option>
        </select>
      </div>

      {/* Filter pills */}
      <div className="sec-filter-row">
        <button className={`sec-filter-pill ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
          All <span className="sec-filter-count">{members.length}</span>
        </button>
        <button className={`sec-filter-pill sec-filter-ok ${filter === 'mfa_on' ? 'active' : ''}`} onClick={() => setFilter('mfa_on')}>
          MFA Enabled <span className="sec-filter-count">{mfaOnCount}</span>
        </button>
        <button className={`sec-filter-pill sec-filter-warn ${filter === 'mfa_off' ? 'active' : ''}`} onClick={() => setFilter('mfa_off')}>
          MFA Disabled <span className="sec-filter-count">{mfaOffCount}</span>
        </button>
      </div>

      <div className="sec-table-wrap">
        <table className="sec-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>MFA</th>
              <th>Passkeys</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(m => (
              <tr key={m.membership_id}>
                <td>
                  <div className="sec-user-cell">
                    <div className="sec-avatar">{(m.name || m.email)[0]?.toUpperCase()}</div>
                    <div>
                      <span className="sec-user-name">{m.name || m.email}</span>
                      <span className="sec-user-email">{m.email}</span>
                    </div>
                  </div>
                </td>
                <td><span className={`sec-role-badge sec-role-${m.org_role}`}>{ROLE_LABELS[m.org_role] ?? m.org_role}</span></td>
                <td>
                  <span className={`sec-status-dot ${m.mfa_enabled ? 'on' : 'off'}`} />
                  <span className="sec-status-text">{m.mfa_enabled ? 'Enabled' : 'Disabled'}</span>
                </td>
                <td>
                  <span className={`sec-status-dot ${m.webauthn_enabled ? 'on' : 'off'}`} />
                  <span className="sec-status-text">{m.webauthn_enabled ? 'Yes' : 'None'}</span>
                </td>
                <td><span className={`status-pill status-${m.status === 'active' ? 'open' : m.status === 'disabled' ? 'closed' : 'new'}`}>{m.status}</span></td>
                <td>
                  <div className="sec-actions">
                    {m.mfa_enabled && <button className="btn btn-ghost btn-xs" onClick={() => void resetMfa(m)} disabled={actionBusy === m.membership_id}><Icon name="refresh" size={13} />Reset MFA</button>}
                    {m.webauthn_enabled && <button className="btn btn-ghost btn-xs" onClick={() => void resetPasskeys(m)} disabled={actionBusy === m.membership_id}><Icon name="key" size={13} />Remove passkeys</button>}
                    {m.org_role !== 'owner' && m.user_id !== auth.user?.id && <button className="btn btn-ghost btn-xs" onClick={() => void updateMember(m, { status: m.status === 'disabled' ? 'active' : 'disabled' }, m.status === 'disabled' ? 'User enabled.' : 'User disabled.')} disabled={actionBusy === m.membership_id}><Icon name={m.status === 'disabled' ? 'check' : 'lock'} size={13} />{m.status === 'disabled' ? 'Enable' : 'Disable'}</button>}
                    {m.org_role !== 'owner' && <select className="field-input sec-role-select" value={m.org_role} onChange={(e) => void updateMember(m, { orgRole: e.target.value }, 'User role updated.')} disabled={actionBusy === m.membership_id} aria-label={`Change role for ${m.name || m.email}`}>
                      {ROLE_OPTIONS.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                    </select>}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="sec-empty">No users match the current search and filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Tab: All Passkeys (org-wide)
   ═══════════════════════════════════════════════════════════════ */

function AllPasskeysTab() {
  const confirm = useConfirm()
  const [passkeys, setPasskeys] = useState<OrgPasskey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res: any = await api('/members/all-passkeys')
      setPasskeys(res.passkeys)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load passkeys')
    }
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  const filteredPasskeys = passkeys.filter(pk => {
    const normalized = search.trim().toLowerCase()
    return !normalized ||
      (pk.device_name ?? '').toLowerCase().includes(normalized) ||
      (pk.user_name ?? '').toLowerCase().includes(normalized) ||
      pk.user_email.toLowerCase().includes(normalized)
  })

  const removePk = async (pk: OrgPasskey) => {
    if (!await confirm(`Remove passkey “${pk.device_name || 'unnamed'}” for ${pk.user_email}?`, { title: 'Remove passkey', confirmLabel: 'Remove passkey', destructive: true })) return
    setActionBusy(pk.credential_id); setError(null); setNotice(null)
    try {
      await api(`/members/${pk.membership_id}/passkeys/${pk.credential_id}`, { method: 'DELETE' })
      setPasskeys(prev => prev.filter(item => item.credential_id !== pk.credential_id))
      setNotice(`Passkey removed for ${pk.user_email}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove passkey')
    } finally {
      setActionBusy(null)
    }
  }

  if (loading) return <div className="sec-loading">Loading passkeys…</div>

  return (
    <div className="sec-section">
      <div className="sec-section-head">
        <div>
          <h2 className="sec-section-title">All Passkeys</h2>
          <p className="sec-section-desc">Passkeys registered by users in your organization.</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}
      <div className="sec-user-toolbar">
        <div className="sec-search-field">
          <Icon name="search" size={15} />
          <input className="field-input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search device or user…" aria-label="Search passkeys" />
        </div>
      </div>

      <div className="sec-table-wrap">
        <table className="sec-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>User</th>
              <th>Registered</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredPasskeys.map(pk => (
              <tr key={pk.credential_id}>
                <td>
                  <div className="sec-pk-device">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                    {pk.device_name || 'Unnamed passkey'}
                  </div>
                </td>
                <td>
                  <div className="sec-user-cell">
                    <span className="sec-user-name">{pk.user_name || pk.user_email}</span>
                    <span className="sec-user-email">{pk.user_email}</span>
                  </div>
                </td>
                <td className="sec-date">{new Date(pk.created_at).toLocaleDateString()}</td>
                <td className="sec-date">{pk.last_used_at ? new Date(pk.last_used_at).toLocaleDateString() : 'Never'}</td>
                <td><button className="btn btn-ghost btn-xs" onClick={() => void removePk(pk)} disabled={actionBusy === pk.credential_id}><Icon name="delete" size={13} />Remove</button></td>
              </tr>
            ))}
            {filteredPasskeys.length === 0 && (
              <tr><td colSpan={5} className="sec-empty">{passkeys.length === 0 ? 'No passkeys registered in your organization' : 'No passkeys match your search.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   Tab: My MFA (personal TOTP + recovery)
   ═══════════════════════════════════════════════════════════════ */

function MyMfaTab() {
  const confirm = useConfirm()
  const [status, setStatus] = useState<{ enabled: boolean; enrollmentStarted: boolean; recoveryCodesRemaining: number } | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [uri, setUri] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showRegenerate, setShowRegenerate] = useState(false)
  const [disableCode, setDisableCode] = useState('')
  const memberships = useAuth((state) => state.memberships)
  const canDisable = !memberships.some((m) => m.tenant.mfaPolicy === 'required' || (m.tenant.mfaPolicy === 'admin_only' && ['owner', 'it_manager', 'service_desk_manager'].includes(m.orgRole)))

  const load = useCallback(async () => {
    try { setStatus(await api('/auth/mfa/status')) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load MFA status') }
  }, [])
  useEffect(() => { void load() }, [load])

  const begin = async () => {
    setBusy(true); setError(null); setNotice(null)
    try {
      const result: any = await api('/auth/mfa/enable', { method: 'POST' })
      setSecret(result.secret); setUri(result.otpauthUrl); setNotice('MFA enrollment started. Add ReyDesk to your authenticator, then verify a code.')
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not start MFA enrollment') }
    finally { setBusy(false) }
  }

  const verify = async () => {
    if (code.length !== 6 || busy) return
    setBusy(true); setError(null)
    try {
      const result: any = await api('/auth/mfa/verify', { method: 'POST', body: { code } })
      setRecoveryCodes(result.recoveryCodes ?? []); setCode(''); setNotice('MFA enabled. Save your recovery codes now.'); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Invalid authenticator code') }
    finally { setBusy(false) }
  }

  const regenerate = async () => {
    if (!code.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const result: any = await api('/auth/mfa/recovery/regenerate', { method: 'POST', body: { code } })
      setRecoveryCodes(result.recoveryCodes); setCode(''); setShowRegenerate(false); setNotice('Recovery codes regenerated. Previous codes are invalid.'); await load()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not regenerate recovery codes') }
    finally { setBusy(false) }
  }

  const disable = async () => {
    if (!disableCode.trim() || busy || !await confirm('Disable MFA for your account?', { title: 'Disable MFA', confirmLabel: 'Disable MFA', destructive: true })) return
    setBusy(true); setError(null)
    try { await api('/auth/mfa/disable', { method: 'POST', body: { code: disableCode.trim() } }); setSecret(null); setUri(null); setRecoveryCodes([]); setDisableCode(''); setNotice('MFA disabled.'); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not disable MFA') }
    finally { setBusy(false) }
  }

  return <div className="sec-section"><div className="sec-section-head"><div><h2 className="sec-section-title">My MFA</h2><p className="sec-section-desc">Set up an authenticator, securely manage recovery codes, and review your sign-in protection.</p></div></div>{error && <Alert kind="error">{error}</Alert>}{notice && <Alert kind="info">{notice}</Alert>}<div className="mfa-status-card"><span className={`sec-status-dot ${status?.enabled ? 'on' : 'off'}`} /><div><strong>{status?.enabled ? 'MFA is enabled' : 'MFA is not enabled'}</strong><p>{status?.enabled ? `${status?.recoveryCodesRemaining ?? 0} unused recovery codes remaining.` : 'Use an authenticator app to protect your account.'}</p></div></div>{!status?.enabled && !secret && <button className="btn btn-primary" onClick={() => void begin()} disabled={busy}><Icon name="shield" size={14} />Set up authenticator MFA</button>}{secret && !status?.enabled && <div className="mfa-enrollment-card"><h3>Finish authenticator setup</h3><ol><li>Add a new account in your authenticator app.</li><li>Scan this QR code, or use the setup key manually.</li><li>Enter the current six-digit code to confirm.</li></ol>{uri ? <MfaQrCode value={uri} /> : null}<code className="auth-secret">{secret}</code><details><summary>Show setup URI</summary><code className="auth-uri">{uri}</code></details><div className="mfa-verify-row"><input className="field-input" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} /><button className="btn btn-primary" onClick={() => void verify()} disabled={busy || code.length !== 6}>Verify and enable</button></div></div>}{recoveryCodes.length > 0 && <div className="mfa-recovery-card"><h3>Save your recovery codes</h3><p>Each code works once. ReyDesk stores only hashes and cannot show this list again.</p><div className="auth-recovery-grid">{recoveryCodes.map((item) => <code key={item}>{item}</code>)}</div><button className="btn btn-ghost" onClick={() => void navigator.clipboard?.writeText(recoveryCodes.join('\\n'))}>Copy codes</button></div>}{status?.enabled && <div className="mfa-actions"><button className="btn btn-ghost" onClick={() => setShowRegenerate((value) => !value)}><Icon name="refresh" size={14} />Regenerate recovery codes</button>{showRegenerate && <div className="mfa-verify-row"><input className="field-input" placeholder="Authenticator or recovery code" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} /><button className="btn btn-primary" onClick={() => void regenerate()} disabled={busy || !code.trim()}>Regenerate</button></div>}{canDisable ? <div className="mfa-disable-block"><div className="mfa-verify-row"><input className="field-input" placeholder="Authenticator or recovery code" value={disableCode} onChange={(event) => setDisableCode(event.target.value.toUpperCase())} /><button className="btn btn-danger" onClick={() => void disable()} disabled={busy || !disableCode.trim()}>Disable MFA</button></div><p className="field-hint">Turning off MFA requires your current authenticator code or an unused recovery code.</p></div> : <p className="mfa-policy-lock"><Icon name="lock" size={14} />Your organization requires MFA for your role, so it can't be turned off here. Ask an administrator to change the policy first.</p>}</div>}</div>
}

/* ═══════════════════════════════════════════════════════════════
   Tab: My Passkeys (personal)
   ═══════════════════════════════════════════════════════════════ */

function MyPasskeysTab() {
  const confirm = useConfirm()
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

  useEffect(() => { void load() }, [load])

  const register = async () => {
    if (busy) return
    setBusy(true); setError(null); setNotice(null)
    try {
      await registerPasskey(deviceName.trim() || undefined)
      setNotice('Passkey registered successfully.')
      setDeviceName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Passkey registration failed')
    }
    setBusy(false)
  }

  const remove = async (c: PasskeyCredential) => {
    if (!await confirm(`Remove passkey “${c.device_name || 'unnamed'}”?`, { title: 'Remove passkey', confirmLabel: 'Remove passkey', destructive: true })) return
    setError(null)
    try {
      await removePasskey(c.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove passkey')
    }
  }

  return (
    <div className="sec-section">
      <div className="sec-section-head">
        <div>
          <h2 className="sec-section-title">My Passkeys</h2>
          <p className="sec-section-desc">Register a passkey — a security key, Windows Hello, Touch ID, or your phone — as a second sign-in factor.</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      <div className="sec-register-row">
        <input className="field-input sec-register-input" placeholder="Device name (optional)"
          value={deviceName} onChange={e => setDeviceName(e.target.value)} />
        <button className="btn btn-primary" disabled={busy} onClick={() => void register()}>
          {busy ? 'Waiting for authenticator…' : 'Register Passkey'}
        </button>
      </div>

      {credentials === null ? (
        <div className="sec-loading">Loading passkeys…</div>
      ) : credentials.length === 0 ? (
        <div className="sec-empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <p>No passkeys registered yet. Add one above for faster, more secure sign-in.</p>
        </div>
      ) : (
        <div className="sec-passkey-list">
          {credentials.map(c => (
            <div key={c.id} className="sec-passkey-card">
              <div className="sec-passkey-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <div className="sec-passkey-info">
                <span className="sec-passkey-name">{c.device_name || 'Passkey'}</span>
                <span className="sec-passkey-meta">
                  Added {new Date(c.created_at).toLocaleDateString()}
                  {c.last_used_at ? ` · Last used ${new Date(c.last_used_at).toLocaleString()}` : ''}
                </span>
              </div>
              <button className="btn btn-ghost btn-xs" onClick={() => void remove(c)}>Remove</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
