import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Field, Modal, PageHeader, useConfirm } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import './TeamsPage.css'

type Member = { user_id: string; name: string | null; email: string; status: string }
type Team = {
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

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

export default function TeamsPage() {
  const auth = useAuth()
  const confirm = useConfirm()
  const membership = auth.memberships.find((item) => item.tenant.id === auth.activeTenantId) ?? auth.memberships[0]
  const canManage = Boolean(membership?.permissions.includes('member.manage'))
  const [teams, setTeams] = useState<Team[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingTeam, setEditingTeam] = useState<Team | null>(null)
  const [membersLoading, setMembersLoading] = useState(false)
  const [memberSearch, setMemberSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')
  const [leadId, setLeadId] = useState('')
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [createChat, setCreateChat] = useState(false)
  const [acceptsTickets, setAcceptsTickets] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [teamResult, memberResult] = await Promise.all([
        api<{ teams: Team[] }>('/teams'),
        api<{ members: Member[] }>('/members'),
      ])
      setTeams(teamResult.teams)
      setMembers(memberResult.members.filter((member) => member.status === 'active'))
    } catch (err) {
      setError(errorMessage(err, 'Teams could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load, auth.activeTenantId])

  const visibleMembers = members.filter((member) => {
    const query = memberSearch.trim().toLowerCase()
    return !query || (member.name ?? '').toLowerCase().includes(query) || member.email.toLowerCase().includes(query)
  })

  const openCreate = () => {
    setEditingTeam(null)
    setName('')
    setLeadId('')
    setMemberIds([])
    setMemberSearch('')
    setMembersLoading(false)
    setCreateChat(false)
    setAcceptsTickets(true)
    setNotice(null)
    setError(null)
    setModalOpen(true)
  }

  const openEdit = async (team: Team) => {
    setEditingTeam(team)
    setName(team.name)
    setLeadId(team.lead_id ?? '')
    setMemberIds(team.member_ids ?? [])
    setMemberSearch('')
    setCreateChat(Boolean(team.chat_room_id))
    setAcceptsTickets(team.accepts_tickets !== false)
    setNotice(null)
    setError(null)
    setModalOpen(true)
    setMembersLoading(true)
    try {
      const result = await api<{ members: Array<{ user_id: string }> }>(`/teams/${team.id}/members`)
      setMemberIds(result.members.map((member) => member.user_id))
    } catch (err) {
      setError(errorMessage(err, 'The team members could not be loaded.'))
    } finally {
      setMembersLoading(false)
    }
  }

  const toggleMember = (userId: string, checked: boolean) => {
    setMemberIds((current) => checked ? [...new Set([...current, userId])] : current.filter((id) => id !== userId))
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || name.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const selected = leadId && !memberIds.includes(leadId) ? [...memberIds, leadId] : memberIds
      if (editingTeam) {
        await api(`/teams/${editingTeam.id}`, { method: 'PATCH', body: { name: name.trim(), leadId: leadId || null, memberIds: selected, acceptsTickets } })
        setNotice(`${name.trim()} was updated.`)
      } else {
        await api('/teams', { method: 'POST', body: { name: name.trim(), leadId: leadId || null, memberIds: selected, createChat, acceptsTickets } })
        setNotice(`${name.trim()} is ready for ticket routing.`)
      }
      setModalOpen(false)
      await load()
    } catch (err) {
      setError(errorMessage(err, `The team could not be ${editingTeam ? 'updated' : 'created'}.`))
    } finally {
      setBusy(false)
    }
  }

  const deleteTeam = async (team: Team) => {
    if (!canManage || busy) return
    if (!await confirm(`Delete ${team.name}? Teams with open tickets cannot be deleted.`, { title: 'Delete team', confirmLabel: 'Delete team', destructive: true })) return
    setBusy(true)
    setError(null)
    try {
      await api(`/teams/${team.id}`, { method: 'DELETE', body: {} })
      setNotice(`${team.name} was deleted.`)
      await load()
    } catch (err) {
      setError(errorMessage(err, 'The team could not be deleted.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <PageHeader
        title="Teams"
        subtitle="Create shared work queues for ticket assignment, escalation, monitoring, and team chat."
        actions={<div className="page-actions"><Link className="btn btn-ghost btn-sm" to="/staff"><Icon name="user" size={14} />Staff management</Link>{canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />Create team</button> : null}</div>}
      />
      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="teams-overview">
        <div><strong>{teams.length}</strong><span>Teams</span><small>Available for routing</small></div>
        <div><strong>{teams.reduce((total, team) => total + (team.open_ticket_count ?? 0), 0)}</strong><span>Open tickets</span><small>Across all teams</small></div>
        <div><strong>{teams.filter((team) => team.chat_room_id).length}</strong><span>Team chats</span><small>Private collaboration rooms</small></div>
      </div>

      <section className="teams-panel">
        <div className="teams-panel-head"><div><h2>Ticket teams</h2><p>Assign tickets to a team so the right people can see, claim, and escalate the work.</p></div><span className="mono muted">{loading ? 'Refreshing…' : `${teams.length} team${teams.length === 1 ? '' : 's'}`}</span></div>
        {loading ? <div className="teams-empty"><span className="etch">Loading teams…</span></div> : teams.length === 0 ? <div className="teams-empty"><Icon name="user" size={28} /><strong>No teams yet</strong><span>Create your first team to make queue filtering and escalation available.</span>{canManage ? <button className="btn btn-primary btn-sm" onClick={openCreate}><Icon name="add" size={14} />Create team</button> : null}</div> : <div className="teams-grid">{teams.map((team) => <article className="team-card" key={team.id}><div className="team-card-head"><span className="team-card-icon"><Icon name="user" size={18} /></span><div><h3>{team.name}</h3><span className="muted">{team.chat_room_id ? `Private chat · #${team.chat_room_name ?? team.name}` : 'Queue team'}</span></div>{canManage ? <div className="team-card-actions"><button className="btn btn-ghost btn-xs" onClick={() => void openEdit(team)} aria-label={`Edit ${team.name}`}><Icon name="edit" size={14} />Edit</button><button className="btn btn-ghost btn-xs team-delete" onClick={() => void deleteTeam(team)} aria-label={`Delete ${team.name}`}><Icon name="delete" size={14} /></button></div> : null}</div><div className="team-card-stats"><div><strong>{team.open_ticket_count ?? 0}</strong><span>Open tickets</span></div><div><strong>{team.member_count ?? 0}</strong><span>Members</span></div><div><strong>{team.lead_name || '—'}</strong><span>Team lead</span></div></div><div className="team-card-foot"><span className={`status-pill ${team.accepts_tickets === false ? 'status-offline' : 'status-open'}`}>{team.accepts_tickets === false ? 'Does not accept tickets' : 'Accepts tickets'}</span><span className="mono muted">{team.chat_room_id ? 'Chat enabled' : 'Routing only'}</span></div><button className="team-manage-link" onClick={() => void openEdit(team)}><Icon name="user" size={14} />Manage members and team settings <Icon name="chevron-right" size={13} /></button></article>)}</div>}
      </section>

      <Modal open={modalOpen} onClose={() => { if (!busy) setModalOpen(false) }} title={editingTeam ? `Edit ${editingTeam.name}` : 'Create a ticket team'} footer={<><button className="btn btn-ghost" type="button" onClick={() => setModalOpen(false)} disabled={busy}>Cancel</button><button className="btn btn-primary" type="submit" form="team-form" disabled={busy || name.trim().length < 2}><Icon name="save" size={14} />{busy ? 'Saving…' : editingTeam ? 'Save changes' : 'Create team'}</button></>}>
        <form id="team-form" onSubmit={(event) => void save(event)}><p className="modal-description">Teams are used by ticket filters, assignment, escalation rules, monitoring alerts, and reports.</p><Field label="Team name" hint="Use a short name agents will recognize quickly."><input className="field-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="Service desk" minLength={2} maxLength={100} required autoFocus /></Field><Field label="Team lead" hint="The lead is always kept as a team member. Change the lead here before removing them."><select className="field-input" value={leadId} onChange={(event) => { const value = event.target.value; setLeadId(value); if (value && !memberIds.includes(value)) setMemberIds((current) => [...current, value]) }}><option value="">No lead assigned</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.name || member.email}</option>)}</select></Field><div className="team-member-picker"><div className="team-member-picker-head"><div><strong>Team members</strong><small>Add or remove people from this team.</small></div><span className="mono muted">{memberIds.length} selected</span></div><div className="team-member-search"><Icon name="search" size={14} /><input className="field-input" value={memberSearch} onChange={(event) => setMemberSearch(event.target.value)} placeholder="Search active staff by name or email…" aria-label="Search staff members" /></div>{membersLoading ? <span className="muted">Loading current members…</span> : visibleMembers.length === 0 ? <span className="muted">No matching active staff members.</span> : <div className="team-member-options">{visibleMembers.map((member) => <label className="team-member-option" key={member.user_id}><input type="checkbox" checked={memberIds.includes(member.user_id)} disabled={member.user_id === leadId} onChange={(event) => toggleMember(member.user_id, event.target.checked)} /><span><strong>{member.name || member.email}{member.user_id === leadId ? ' · lead' : ''}</strong><small>{member.email}</small></span></label>)}</div>}</div><label className="team-chat-toggle"><input type="checkbox" checked={acceptsTickets} onChange={(event) => setAcceptsTickets(event.target.checked)} /><span><strong>Accept tickets</strong><small>Allow this team to appear as a destination for new tickets, assignment, escalation, and forwarding.</small></span></label>{!editingTeam ? <label className="team-chat-toggle"><input type="checkbox" checked={createChat} onChange={(event) => setCreateChat(event.target.checked)} /><span><strong>Create a private team chat</strong><small>Only team members, the lead, and organization managers will see the room.</small></span></label> : editingTeam.chat_room_id ? <div className="team-chat-note"><Icon name="mail" size={15} /><span><strong>Private team chat is enabled</strong><small>Chat membership follows this team. Add or remove members above to keep access current.</small></span></div> : null}</form>
      </Modal>
    </Shell>
  )
}
