import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, useConfirm } from '../components/ui.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import { Icon } from '../components/Icons.js'

interface Member {
  membership_id: string
  user_id: string
  email: string
  name: string | null
  org_role: string
  status: 'active' | 'invited' | 'disabled'
  user_status?: string
  mfa_enabled?: boolean
  webauthn_enabled?: boolean
  assigned_device_count?: number
  created_at: string
}

interface Team {
  id: string
  name: string
  lead_id: string | null
  lead_name?: string | null
  lead_email?: string | null
  member_count?: number
  member_ids?: string[]
  chat_room_id?: string | null
  chat_room_name?: string | null
  open_ticket_count?: number
  accepts_tickets?: boolean
  created_at: string
}

const ROLES = [
  { value: 'it_manager', label: 'IT Manager', description: 'Manage the workspace, people, and operations.' },
  { value: 'service_desk_manager', label: 'Service Desk Manager', description: 'Lead service desk operations and ticket workflows.' },
  { value: 'analyst', label: 'Analyst', description: 'Work tickets and customer support requests.' },
  { value: 'desktop_engineer', label: 'Desktop Engineer', description: 'Support endpoints and remote sessions.' },
  { value: 'infrastructure_engineer', label: 'Infrastructure Engineer', description: 'Manage infrastructure and endpoint operations.' },
  { value: 'security_analyst', label: 'Security Analyst', description: 'Review security, access, and audit activity.' },
  { value: 'auditor', label: 'Auditor', description: 'Read-only access to operational records and reports.' },
  { value: 'end_user', label: 'End User', description: 'Raise and follow their own support requests.' },
]

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  ...Object.fromEntries(ROLES.map((role) => [role.value, role.label])),
}

type StatusFilter = '' | Member['status']
type MfaFilter = '' | 'enabled' | 'disabled'
type StaffTab = 'members' | 'teams'

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function StaffPage() {
  const auth = useAuth()
  const activeMembership = auth.memberships.find((membership) => membership.tenant.id === auth.activeTenantId) ?? auth.memberships[0]
  const canManage = Boolean(activeMembership?.permissions.includes('member.manage'))
  const confirm = useConfirm()

  const [tab, setTab] = useState<StaffTab>('members')
  const [members, setMembers] = useState<Member[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [membersError, setMembersError] = useState<string | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [teamsLoading, setTeamsLoading] = useState(true)
  const [teamsError, setTeamsError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('')
  const [mfa, setMfa] = useState<MfaFilter>('')
  const [inviteOpen, setInviteOpen] = useState(false)
  const [selected, setSelected] = useState<Member | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteRole, setInviteRole] = useState('analyst')
  const [teamOpen, setTeamOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)
  const [teamName, setTeamName] = useState('')
  const [teamLeadId, setTeamLeadId] = useState('')
  const [teamMemberIds, setTeamMemberIds] = useState<string[]>([])
  const [teamChatEnabled, setTeamChatEnabled] = useState(false)
  const [teamAcceptsTickets, setTeamAcceptsTickets] = useState(true)
  const [modalError, setModalError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadMembers = useCallback(async () => {
    setMembersLoading(true)
    setMembersError(null)
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      if (status) params.set('status', status)
      if (mfa) params.set('mfa', mfa)
      const result = await api<{ members: Member[] }>(`/members${params.toString() ? `?${params}` : ''}`)
      setMembers(result.members)
    } catch (error) {
      setMembersError(messageFrom(error, 'Staff could not be loaded.'))
    } finally {
      setMembersLoading(false)
    }
  }, [mfa, query, status])

  const loadTeams = useCallback(async () => {
    setTeamsLoading(true)
    setTeamsError(null)
    try {
      const result = await api<{ teams: Team[] }>('/teams')
      setTeams(result.teams)
    } catch (error) {
      setTeamsError(messageFrom(error, 'Teams could not be loaded.'))
    } finally {
      setTeamsLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMembers(), query.trim() ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [loadMembers, query])

  useEffect(() => {
    void loadTeams()
  }, [loadTeams, auth.activeTenantId])

  const activeCount = useMemo(() => members.filter((member) => member.status === 'active').length, [members])
  const invitedCount = useMemo(() => members.filter((member) => member.status === 'invited').length, [members])
  const protectedCount = useMemo(() => members.filter((member) => member.mfa_enabled || member.webauthn_enabled).length, [members])
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members])

  const openInvite = () => {
    setInviteEmail('')
    setInviteName('')
    setInviteRole('analyst')
    setModalError(null)
    setNotice(null)
    setInviteOpen(true)
  }

  const handleInvite = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setModalError(null)
    setNotice(null)
    try {
      await api('/members/invite', {
        method: 'POST',
        body: { email: inviteEmail.trim(), name: inviteName.trim() || undefined, orgRole: inviteRole },
      })
      setInviteOpen(false)
      setNotice(`Invitation sent to ${inviteEmail.trim()}.`)
      await loadMembers()
    } catch (error) {
      setModalError(messageFrom(error, 'The invitation could not be sent.'))
    } finally {
      setBusy(false)
    }
  }

  const updateMember = async (member: Member, patch: { orgRole?: string; status?: Member['status'] }, message: string) => {
    if (busy) return
    setBusy(true)
    setModalError(null)
    setNotice(null)
    try {
      await api(`/members/${member.membership_id}`, { method: 'PATCH', body: patch })
      setNotice(message)
      setSelected((current) => current
        ? { ...current, ...(patch.orgRole !== undefined ? { org_role: patch.orgRole } : {}), ...(patch.status !== undefined ? { status: patch.status } : {}) }
        : current)
      await loadMembers()
    } catch (error) {
      setModalError(messageFrom(error, 'The member could not be updated.'))
    } finally {
      setBusy(false)
    }
  }

  const resetSecurity = async (member: Member, kind: 'mfa' | 'passkeys') => {
    if (busy) return
    const label = kind === 'mfa' ? 'MFA' : 'passkeys'
    if (!await confirm(`Reset ${label} for ${member.name || member.email}?`, { title: `Reset ${label}`, confirmLabel: `Reset ${label}`, destructive: true })) return
    setBusy(true)
    setModalError(null)
    setNotice(null)
    try {
      await api(`/members/${member.membership_id}/reset-${kind}`, { method: 'POST', body: {} })
      setNotice(`${label} reset for ${member.name || member.email}.`)
      setSelected((current) => current
        ? { ...current, ...(kind === 'mfa' ? { mfa_enabled: false } : { webauthn_enabled: false }) }
        : current)
      await loadMembers()
    } catch (error) {
      setModalError(messageFrom(error, `Could not reset ${label}.`))
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (member: Member) => {
    if (busy || !await confirm(`Remove ${member.name || member.email} from this organization?`, { title: 'Remove team member', confirmLabel: 'Remove member', destructive: true })) return
    setBusy(true)
    setModalError(null)
    setNotice(null)
    try {
      await api(`/members/${member.membership_id}`, { method: 'DELETE' })
      setSelected(null)
      setNotice(`${member.name || member.email} was removed from the organization.`)
      await loadMembers()
    } catch (error) {
      setModalError(messageFrom(error, 'The member could not be removed.'))
    } finally {
      setBusy(false)
    }
  }

  const openCreateTeam = () => {
    setEditingTeam(null)
    setTeamName('')
    setTeamLeadId('')
    setTeamMemberIds([])
    setTeamChatEnabled(false)
    setTeamAcceptsTickets(true)
    setModalError(null)
    setNotice(null)
    setTeamOpen(true)
  }

  const openEditTeam = (team: Team) => {
    setEditingTeam(team)
    setTeamName(team.name)
    setTeamLeadId(team.lead_id ?? '')
    setTeamMemberIds(team.member_ids ?? (team.lead_id ? [team.lead_id] : []))
    setTeamChatEnabled(Boolean(team.chat_room_id))
    setTeamAcceptsTickets(team.accepts_tickets !== false)
    setModalError(null)
    setNotice(null)
    setTeamOpen(true)
  }

  const saveTeam = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setModalError(null)
    setNotice(null)
    try {
      const body = {
        name: teamName.trim(),
        leadId: teamLeadId || null,
        memberIds: teamMemberIds,
        acceptsTickets: teamAcceptsTickets,
        ...(editingTeam ? {} : { createChat: teamChatEnabled }),
      }
      if (editingTeam) {
        await api(`/teams/${editingTeam.id}`, { method: 'PATCH', body })
        setNotice(`${teamName.trim()} was updated.`)
      } else {
        await api('/teams', { method: 'POST', body })
        setNotice(`${teamName.trim()} was created.`)
      }
      setTeamOpen(false)
      await loadTeams()
    } catch (error) {
      setModalError(messageFrom(error, 'The team could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  const deleteTeam = async (team: Team) => {
    if (busy || !await confirm(`Delete ${team.name}? Open tickets must be reassigned first.`, { title: 'Delete team', confirmLabel: 'Delete team', destructive: true })) return
    setBusy(true)
    setTeamsError(null)
    setNotice(null)
    try {
      await api(`/teams/${team.id}`, { method: 'DELETE' })
      setNotice(`${team.name} was deleted.`)
      await loadTeams()
    } catch (error) {
      setTeamsError(messageFrom(error, 'The team could not be deleted.'))
    } finally {
      setBusy(false)
    }
  }

  return <Shell>
    <PageHeader
      title="Staff management"
      subtitle="Invite people, organize ticket teams, and review organization access."
      actions={canManage ? <button className="btn btn-primary btn-sm" onClick={tab === 'teams' ? openCreateTeam : openInvite}><Icon name="add" size={14} />{tab === 'teams' ? 'Create team' : 'Invite member'}</button> : undefined}
    />
    {notice ? <Alert kind="info">{notice}</Alert> : null}

    <div className="staff-tabs" role="tablist" aria-label="Staff management sections">
      <button type="button" role="tab" aria-selected={tab === 'members'} className={`staff-tab${tab === 'members' ? ' active' : ''}`} onClick={() => setTab('members')}><Icon name="user" size={15} />Members<span>{members.length}</span></button>
      <button type="button" role="tab" aria-selected={tab === 'teams'} className={`staff-tab${tab === 'teams' ? ' active' : ''}`} onClick={() => setTab('teams')}><Icon name="folder" size={15} />Teams<span>{teams.length}</span></button>
    </div>

    {tab === 'members' ? <>
      {membersError ? <Alert kind="error">{membersError}</Alert> : null}
      <div className="staff-summary-grid">
        <div className="staff-summary-card"><strong>{members.length}</strong><span>Members shown</span><small>Matching current filters</small></div>
        <div className="staff-summary-card"><strong>{activeCount}</strong><span>Active</span><small>Can access the workspace</small></div>
        <div className="staff-summary-card"><strong>{invitedCount}</strong><span>Invited</span><small>Awaiting acceptance</small></div>
        <div className="staff-summary-card"><strong>{protectedCount}</strong><span>Security protected</span><small>MFA or passkey enabled</small></div>
      </div>

      <div className="staff-toolbar">
        <div className="staff-search"><Icon name="search" size={15} /><input className="field-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name or email…" aria-label="Search staff" /></div>
        <select className="field-input" value={status} onChange={(event) => setStatus(event.target.value as StatusFilter)} aria-label="Filter by status"><option value="">All statuses</option><option value="active">Active</option><option value="invited">Invited</option><option value="disabled">Disabled</option></select>
        <select className="field-input" value={mfa} onChange={(event) => setMfa(event.target.value as MfaFilter)} aria-label="Filter by security"><option value="">All security states</option><option value="enabled">MFA enabled</option><option value="disabled">MFA not enabled</option></select>
        {query || status || mfa ? <button className="btn btn-link btn-sm" onClick={() => { setQuery(''); setStatus(''); setMfa('') }}>Clear filters</button> : null}
      </div>

      <section className="staff-panel">
        <div className="staff-panel-head"><div><h2>Organization members</h2><p>Roles and membership status take effect immediately.</p></div><span className="mono muted">{membersLoading ? 'Refreshing…' : `${members.length} result${members.length === 1 ? '' : 's'}`}</span></div>
        {membersLoading ? <div className="staff-loading"><span className="etch">Loading staff…</span></div> : members.length === 0 ? <div className="staff-empty"><Icon name="user" size={25} /><strong>No members found</strong><span>Try changing your filters or invite your first team member.</span>{canManage ? <button className="btn btn-primary btn-sm" onClick={openInvite}><Icon name="add" size={14} />Invite member</button> : null}</div> : <div className="staff-table-wrap"><table className="staff-table"><thead><tr><th>Member</th><th>Role</th><th>Devices</th><th>Security</th><th>Status</th><th>Joined</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{members.map((member) => <tr key={member.membership_id} onClick={() => { setModalError(null); setSelected(member) }}><td><button className="staff-member-cell" onClick={(event) => { event.stopPropagation(); setModalError(null); setSelected(member) }}><span className="staff-avatar">{(member.name || member.email).slice(0, 1).toUpperCase()}</span><span><strong>{member.name || 'Unnamed member'}</strong><small>{member.email}</small></span></button></td><td><span className={`role-badge role-${member.org_role}`}>{ROLE_LABELS[member.org_role] || member.org_role}</span></td><td><span className="mono">{member.assigned_device_count ?? 0}</span></td><td><span className={`staff-security-state ${member.mfa_enabled || member.webauthn_enabled ? 'protected' : 'needs-setup'}`}><Icon name={member.mfa_enabled || member.webauthn_enabled ? 'shield' : 'alert'} size={14} />{member.mfa_enabled || member.webauthn_enabled ? 'Protected' : 'Needs setup'}</span></td><td><span className={`status-pill status-${member.status === 'active' ? 'open' : member.status === 'invited' ? 'new' : 'offline'}`}>{member.status}</span></td><td className="mono muted">{dateLabel(member.created_at)}</td><td><button className="btn btn-ghost btn-xs" onClick={(event) => { event.stopPropagation(); setModalError(null); setSelected(member) }} aria-label={`Open ${member.name || member.email}`}><Icon name="more" size={15} /></button></td></tr>)}</tbody></table></div>}
      </section>

      <Modal open={inviteOpen} onClose={() => { if (!busy) setInviteOpen(false) }} title="Invite a team member" footer={<><button className="btn btn-ghost" type="button" onClick={() => setInviteOpen(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" type="submit" form="staff-invite-form" disabled={busy || !inviteEmail.trim()}><Icon name="send" size={14} />{busy ? 'Sending…' : 'Send invitation'}</button></>}>
        <form id="staff-invite-form" onSubmit={(event) => void handleInvite(event)}><p className="modal-description">The member will receive an invitation and appear as pending until they accept it.</p>{modalError ? <div className="modal-inline-error" role="alert">{modalError}</div> : null}<Field label="Email address"><input className="field-input" type="email" required value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="colleague@company.com" autoFocus /></Field><Field label="Name" hint="Optional. They can update it from their profile."><input className="field-input" value={inviteName} onChange={(event) => setInviteName(event.target.value)} placeholder="Alex Morgan" /></Field><Field label="Organization role"><select className="field-input" value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>{ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></Field><p className="staff-role-help">{ROLES.find((role) => role.value === inviteRole)?.description}</p></form>
      </Modal>

      <Modal open={Boolean(selected)} onClose={() => { if (!busy) setSelected(null) }} title={selected ? selected.name || selected.email : 'Member details'} width={620} footer={<button className="btn btn-ghost" onClick={() => setSelected(null)}>Close</button>}>
        {selected ? <div className="staff-detail"><div className="staff-detail-identity"><span className="staff-avatar staff-avatar-large">{(selected.name || selected.email).slice(0, 1).toUpperCase()}</span><div><h2>{selected.name || 'Unnamed member'}</h2><p className="muted">{selected.email}</p><span className="mono muted">Member since {dateLabel(selected.created_at)}</span></div></div>{modalError ? <div className="modal-inline-error" role="alert">{modalError}</div> : null}<div className="staff-detail-grid"><div><span className="field-label">Organization role</span>{canManage && selected.org_role !== 'owner' ? <select className="field-input" value={selected.org_role} disabled={busy} onChange={(event) => void updateMember(selected, { orgRole: event.target.value }, 'Role updated.')}><option value={selected.org_role}>{ROLE_LABELS[selected.org_role] || selected.org_role}</option>{ROLES.filter((role) => role.value !== selected.org_role).map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select> : <strong>{ROLE_LABELS[selected.org_role] || selected.org_role}</strong>}</div><div><span className="field-label">Membership status</span>{canManage && selected.org_role !== 'owner' ? <select className="field-input" value={selected.status} disabled={busy} onChange={(event) => void updateMember(selected, { status: event.target.value as Member['status'] }, 'Membership status updated.')}><option value="active">Active</option><option value="invited">Invited</option><option value="disabled">Disabled</option></select> : <strong>{selected.status}</strong>}</div></div><div className="staff-security-panel"><div><Icon name={selected.mfa_enabled ? 'shield' : 'alert'} size={16} /><span><strong>MFA</strong><small>{selected.mfa_enabled ? 'Enabled' : 'Not enabled'}</small></span></div><div><Icon name={selected.webauthn_enabled ? 'key' : 'alert'} size={16} /><span><strong>Passkeys</strong><small>{selected.webauthn_enabled ? 'Configured' : 'Not configured'}</small></span></div></div>{canManage && selected.user_id !== auth.user?.id && selected.org_role !== 'owner' ? <div className="staff-detail-actions"><button className="btn btn-ghost btn-sm" onClick={() => void resetSecurity(selected, 'mfa')} disabled={busy}><Icon name="refresh" size={14} />Reset MFA</button><button className="btn btn-ghost btn-sm" onClick={() => void resetSecurity(selected, 'passkeys')} disabled={busy}><Icon name="key" size={14} />Reset passkeys</button><button className="btn btn-danger btn-sm" onClick={() => void removeMember(selected)} disabled={busy}><Icon name="delete" size={14} />Remove member</button></div> : null}</div> : null}
      </Modal>
    </> : <>
      {teamsError ? <Alert kind="error">{teamsError}</Alert> : null}
      <section className="staff-team-intro"><div><span className="eyebrow">Ticket routing</span><h2>Teams turn the queue into a workable system</h2><p>Create teams that match how support is delivered. They appear in ticket filters, assignment, escalation, monitoring routing, and team reports. A team can have one lead responsible for its queue.</p></div>{canManage ? <button className="btn btn-primary btn-sm" onClick={openCreateTeam}><Icon name="add" size={14} />Create team</button> : null}</section>
      <section className="staff-panel"><div className="staff-panel-head"><div><h2>Ticket teams</h2><p>Use names your agents will recognize quickly, such as Service desk or Infrastructure.</p></div><span className="mono muted">{teamsLoading ? 'Refreshing…' : `${teams.length} team${teams.length === 1 ? '' : 's'}`}</span></div>{teamsLoading ? <div className="staff-loading"><span className="etch">Loading teams…</span></div> : teams.length === 0 ? <div className="staff-empty"><Icon name="folder" size={25} /><strong>No teams yet</strong><span>Create your first queue team, then use it to route tickets and configure escalations.</span>{canManage ? <button className="btn btn-primary btn-sm" onClick={openCreateTeam}><Icon name="add" size={14} />Create team</button> : null}</div> : <div className="staff-team-grid">{teams.map((team) => <article className="staff-team-card" key={team.id}><div className="staff-team-card-head"><span className="staff-team-icon"><Icon name="folder" size={18} /></span><div><h3>{team.name}</h3><span className="muted">Created {dateLabel(team.created_at)}</span></div><div className="staff-team-actions">{canManage ? <><button className="btn btn-ghost btn-xs" onClick={() => openEditTeam(team)} aria-label={`Edit ${team.name}`}><Icon name="edit" size={14} /></button><button className="btn btn-ghost btn-xs" onClick={() => void deleteTeam(team)} aria-label={`Delete ${team.name}`}><Icon name="delete" size={14} /></button></> : null}</div></div><div className="staff-team-meta"><div><span>Team lead</span><strong>{team.lead_name || 'Not assigned'}</strong>{team.lead_email ? <small>{team.lead_email}</small> : null}</div><div><span>Open tickets</span><strong>{team.open_ticket_count ?? 0}</strong><small>Active queue work</small></div><div><span>Members</span><strong>{team.member_count ?? 0}</strong><small>{team.chat_room_id ? 'Private chat enabled' : 'No private chat'}</small></div></div><div className="staff-team-foot"><span className={`status-pill ${team.accepts_tickets === false ? 'status-offline' : 'status-open'}`}>{team.accepts_tickets === false ? 'Does not accept tickets' : 'Accepts tickets'}</span><span className="mono muted">{team.chat_room_id ? `# ${team.chat_room_name ?? team.name}` : 'Queue filter'}</span></div></article>)}</div>}</section>

      <Modal open={teamOpen} onClose={() => { if (!busy) setTeamOpen(false) }} title={editingTeam ? 'Edit team' : 'Create a ticket team'} footer={<><button className="btn btn-ghost" type="button" onClick={() => setTeamOpen(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" type="submit" form="team-form" disabled={busy || teamName.trim().length < 2}><Icon name="save" size={14} />{busy ? 'Saving…' : editingTeam ? 'Save changes' : 'Create team'}</button></>}>
        <form id="team-form" onSubmit={(event) => void saveTeam(event)}><p className="modal-description">Teams are shared work queues. They can be selected in ticket filters, assignment, escalation, monitoring routing, and reports.</p>{modalError ? <div className="modal-inline-error" role="alert">{modalError}</div> : null}<Field label="Team name" hint="Use a short, recognizable queue name."><input className="field-input" value={teamName} onChange={(event) => setTeamName(event.target.value)} placeholder="Service desk" autoFocus required minLength={2} maxLength={100} /></Field><Field label="Team lead" hint="Optional. The lead receives queue and monitoring notifications."><select className="field-input" value={teamLeadId} onChange={(event) => { const value = event.target.value; setTeamLeadId(value); if (value && !teamMemberIds.includes(value)) setTeamMemberIds((current) => [...current, value]) }}><option value="">No lead assigned</option>{activeMembers.map((member) => <option key={member.user_id} value={member.user_id}>{member.name || member.email} · {ROLE_LABELS[member.org_role] || member.org_role}</option>)}</select></Field><div className="team-collaboration-section"><div className="team-collaboration-head"><div><strong>Team members</strong><small>Add the people who should receive this team’s queue context and private chat.</small></div><span className="mono muted">{teamMemberIds.length} selected</span></div><div className="team-member-picker">{activeMembers.length === 0 ? <span className="muted">Invite or activate a staff member first.</span> : activeMembers.map((member) => <label key={member.user_id} className="team-member-option"><input type="checkbox" checked={teamMemberIds.includes(member.user_id)} onChange={(event) => setTeamMemberIds((current) => event.target.checked ? [...current, member.user_id] : current.filter((id) => id !== member.user_id))} /><span><strong>{member.name || member.email}</strong><small>{member.email} · {ROLE_LABELS[member.org_role] || member.org_role}</small></span></label>)}</div></div><label className="team-chat-toggle"><input type="checkbox" checked={teamAcceptsTickets} onChange={(event) => setTeamAcceptsTickets(event.target.checked)} /><span><strong>Accept tickets</strong><small>Allow this team to receive new tickets, assignment, escalation, and forwarding.</small></span></label>{editingTeam ? (editingTeam.chat_room_id ? <div className="team-chat-status"><strong>Private team chat is active</strong><span>Members selected above can access #{editingTeam.chat_room_name ?? editingTeam.name}. Organization managers can always moderate it.</span></div> : <div className="team-chat-status"><strong>No private chat yet</strong><span>Private team chat can be enabled when this team is created.</span></div>) : <label className="team-chat-toggle"><input type="checkbox" checked={teamChatEnabled} onChange={(event) => setTeamChatEnabled(event.target.checked)} /><span><strong>Create a private team chat</strong><small>Only selected team members, the team lead, and organization managers will see this room.</small></span></label>}{activeMembers.length === 0 ? <p className="staff-role-help">Invite or activate a staff member first if this team needs members or a lead.</p> : null}</form>
      </Modal>
    </>}
  </Shell>
}
