import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { getAccessToken } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import {
  addTicketLink, assignTicket, getTicket, listTicketLinks, removeTicketLink, replyTicket, setTicketStatus,
  downloadAttachment, listAttachments, updateTicket, uploadAttachment,
  escalateTicket, getTicketEscalations, forwardTicket, listTeams, listTeamMembers,
  getTicketLock, unlockTicket, heartbeatLock, forceUnlockTicket,
  startViewingTicket, stopViewingTicket, heartbeatViewing, getTicketViewers,
  slaSummary, STATUS_LABELS, formatWhen, type Attachment, type Thread, type Ticket, type TicketDevice, type TicketLink,
  type Escalation, type Team, type TicketLockInfo,
} from '../lib/tickets.js'
import { listCannedResponses, type CannedResponse } from '../lib/canned.js'
import { listDevices, type Device } from '../lib/devices.js'
import { draftKbArticle, getTriageState, listSimilarTickets, retryTriage, stopTriage, summarizeTicket, type KbDraftArticle, type SimilarTicket, type TriageState } from '../lib/ai.js'

const STATUS_OPTIONS = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated', 'resolved', 'closed']

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const auth = useAuth()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [ticketDevice, setTicketDevice] = useState<TicketDevice | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [composerMode, setComposerMode] = useState<'public' | 'internal'>('public')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [canned, setCanned] = useState<CannedResponse[]>([])
  const [cannedQuery, setCannedQuery] = useState('')
  const [showCanned, setShowCanned] = useState(false)
  const [deviceSaving, setDeviceSaving] = useState(false)
  const [links, setLinks] = useState<TicketLink[]>([])
  const [linkType, setLinkType] = useState('related')
  const [linkTargetType, setLinkTargetType] = useState('ticket')
  const [linkTargetId, setLinkTargetId] = useState('')
  const [aiSummary, setAiSummary] = useState<string | null>(null)
  const [aiSummaryBusy, setAiSummaryBusy] = useState(false)
  const [aiSimilar, setAiSimilar] = useState<SimilarTicket[]>([])
  const [aiSimilarDone, setAiSimilarDone] = useState(false)
  const [aiSimilarBusy, setAiSimilarBusy] = useState(false)
  const [aiDraft, setAiDraft] = useState<KbDraftArticle | null>(null)
  const [aiDraftBusy, setAiDraftBusy] = useState(false)
  const [aiTriage, setAiTriage] = useState<TriageState | null>(null)
  const [aiTriageBusy, setAiTriageBusy] = useState(false)

  // Ticket locking & viewing
  const [ticketLock, setTicketLock] = useState<TicketLockInfo | null>(null)
  const [lockIsMine, setLockIsMine] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [viewers, setViewers] = useState<Array<{ user_id: string; name: string; email: string; viewing_at: string }>>([])

  // Escalation & forward
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [escTeam, setEscTeam] = useState('')
  const [escReason, setEscReason] = useState('')
  const [escBusy, setEscBusy] = useState(false)
  const [fwdTeam, setFwdTeam] = useState('')
  const [fwdNote, setFwdNote] = useState('')
  const [fwdBusy, setFwdBusy] = useState(false)
  const [showEscalate, setShowEscalate] = useState(false)
  const [showForward, setShowForward] = useState(false)

  const canUseAi = useAuth((state) => state.memberships.some((m) => m.permissions.includes('ai.use')))
  const canOverrideTicketLock = auth.memberships.some((m) => m.permissions.includes('settings.manage'))

  const load = useCallback(async () => {
    if (!id) return
    try {
      const res = await getTicket(id)
      setTicket(res.ticket)
      setTicketDevice(res.device)
      setThreads(res.threads)
      try {
        setAttachments((await listAttachments(id)).attachments)
      } catch { setAttachments([]) }
      try {
        setLinks((await listTicketLinks(id)).links)
      } catch { setLinks([]) }
      // Check lock status
      try {
        const lockRes = await getTicketLock(id)
        setTicketLock(lockRes.lock)
        setLockIsMine(lockRes.is_mine)
      } catch {
        setTicketLock(null)
        setLockIsMine(false)
      }
      // Check viewers
      try {
        const viewersRes = await getTicketViewers(id)
        setViewers(viewersRes.viewers)
      } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket')
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    listCannedResponses()
      .then((r) => setCanned(r.cannedResponses))
      .catch(() => setCanned([]))
    listDevices()
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]))
    listTeams().then((r) => setTeams(r.teams)).catch(() => {})
    if (id) {
      getTicketEscalations(id).then((r) => setEscalations(r.escalations)).catch(() => {})
    }
  }, [id])

  // These effects must run before the loading/error returns below. Keeping them
  // unconditional preserves React's hook order while the ticket is fetched.
  useEffect(() => {
    if (!id || !canUseAi) return
    getTriageState(id).then((result) => setAiTriage(result.triage)).catch(() => setAiTriage(null))
  }, [id, canUseAi])

  useEffect(() => {
    if (!id) return
    const interval = setInterval(() => {
      heartbeatLock(id).catch(() => {})
      heartbeatViewing(id).catch(() => {})
    }, 25_000)
    return () => clearInterval(interval)
  }, [id])

  useEffect(() => {
    if (!id) return
    const fetchViewers = async () => {
      try {
        const res = await getTicketViewers(id)
        setViewers(res.viewers)
      } catch { /* ignore */ }
    }
    void fetchViewers()
    const interval = setInterval(fetchViewers, 10_000)
    return () => clearInterval(interval)
  }, [id])

  // Refresh the lock banner independently of the ticket payload so a manager
  // force-unlock or a five-minute expiry is reflected without a full reload.
  useEffect(() => {
    if (!id) return
    const refreshLock = async () => {
      try {
        const result = await getTicketLock(id)
        setTicketLock(result.lock)
        setLockIsMine(result.is_mine)
      } catch { /* ignore transient refresh failures */ }
    }
    const interval = setInterval(refreshLock, 10_000)
    return () => clearInterval(interval)
  }, [id])

  useEffect(() => {
    if (!id) return
    void startViewingTicket(id)
    return () => {
      void stopViewingTicket(id)
      void unlockTicket(id)
    }
  }, [id])

  if (error) {
    return (
      <Shell>
        <Alert kind="error">{error}</Alert>
      </Shell>
    )
  }
  if (!ticket) {
    return (
      <Shell>
        <span className="etch">Loading ticket…</span>
      </Shell>
    )
  }

  const sla = slaSummary(ticket)
  const readOnlyForLock = Boolean(ticketLock && !lockIsMine && !canOverrideTicketLock)

  const sendReply = async () => {
    if (!draft.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await replyTicket(ticket.id, draft.trim(), composerMode)
      setDraft('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reply failed')
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = async (status: string) => {
    setError(null)
    try {
      const res = await setTicketStatus(ticket.id, status)
      setTicket(res.ticket)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    }
  }

  const assignToMe = async () => {
    if (!auth.user) return
    setError(null)
    try {
      // The API claims and locks in one transaction. Do not lock first: that
      // would leave an orphaned lock if assignment failed or raced another agent.
      const res = await assignTicket(ticket.id, auth.user.id)
      setTicket(res.ticket)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assign failed')
    }
  }

  const handleEscalate = async () => {
    if (!ticket || !escReason.trim()) return
    setEscBusy(true)
    try {
      await escalateTicket(ticket.id, { to_team_id: escTeam || undefined, reason: escReason })
      setEscReason('')
      setEscTeam('')
      setShowEscalate(false)
      await load()
      const r = await getTicketEscalations(ticket.id)
      setEscalations(r.escalations)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Escalation failed')
    }
    setEscBusy(false)
  }

  const handleForward = async () => {
    if (!ticket || !fwdTeam) return
    setFwdBusy(true)
    try {
      await forwardTicket(ticket.id, { to_team_id: fwdTeam, note: fwdNote })
      setFwdNote('')
      setFwdTeam('')
      setShowForward(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Forward failed')
    }
    setFwdBusy(false)
  }

  // ── Lock handlers ──
  const handleForceUnlock = async () => {
    if (!ticket || !canOverrideTicketLock) return
    setLockBusy(true)
    try {
      await forceUnlockTicket(ticket.id)
      setTicketLock(null)
      setLockIsMine(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not force unlock ticket')
    }
    setLockBusy(false)
  }

  const changeDevice = async (deviceId: string) => {
    if (!ticket || deviceSaving) return
    setDeviceSaving(true)
    setError(null)
    try {
      const res = await updateTicket(ticket.id, { deviceId: deviceId || null })
      setTicket(res.ticket)
      setTicketDevice(deviceId ? devices.find((device) => device.id === deviceId) ?? ticketDevice : null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link device')
    } finally {
      setDeviceSaving(false)
    }
  }

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || uploading || !ticket) return
    setUploading(true)
    setUploadError(null)
    try {
      await uploadAttachment(getAccessToken() ?? '', ticket.id, file)
      await load()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const addLink = async () => {
    if (!ticket || !linkTargetId.trim()) return
    setError(null)
    try {
      await addTicketLink(ticket.id, { linkType, targetType: linkTargetType, targetId: linkTargetId.trim() })
      setLinkTargetId('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link')
    }
  }

  const removeLink = async (link: TicketLink) => {
    setError(null)
    try {
      await removeTicketLink(link.id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlink')
    }
  }

  const runAiSummary = async () => {
    if (!ticket || aiSummaryBusy) return
    setAiSummaryBusy(true)
    setError(null)
    try {
      const res = await summarizeTicket(ticket.id)
      setAiSummary(res.summary)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Summary failed')
    } finally {
      setAiSummaryBusy(false)
    }
  }

  const runAiSimilar = async () => {
    if (!ticket || aiSimilarBusy) return
    setAiSimilarBusy(true)
    setError(null)
    try {
      setAiSimilar((await listSimilarTickets(ticket.id)).similar)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Similarity search failed')
    } finally {
      setAiSimilarDone(true)
      setAiSimilarBusy(false)
    }
  }

  const runAiDraft = async () => {
    if (!ticket || aiDraftBusy) return
    setAiDraftBusy(true)
    setError(null)
    try {
      setAiDraft((await draftKbArticle(ticket.id)).article)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'KB draft failed')
    } finally {
      setAiDraftBusy(false)
    }
  }

  const runAiTriageAction = async (action: 'retry' | 'stop') => {
    if (!ticket || aiTriageBusy) return
    setAiTriageBusy(true)
    setError(null)
    try {
      if (action === 'retry') {
        await retryTriage(ticket.id)
        setAiTriage((await getTriageState(ticket.id)).triage)
      } else {
        const result = await stopTriage(ticket.id)
        setAiTriage(result.triage)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI triage action failed')
    } finally {
      setAiTriageBusy(false)
    }
  }

  const ext = ticket.ext ?? {}
  const extKeys = Object.keys(ext)
  const extLabel: Record<string, string> = {
    rootCause: 'Root cause',
    workaround: 'Workaround',
    risk: 'Risk',
    implementationPlan: 'Implementation plan',
    backoutPlan: 'Backout plan',
    scheduledAt: 'Scheduled for',
  }

  return (
    <Shell>
      <div className="ticket-detail-layout">
      <div className="ticket-detail-scroll">
      <div className="ticket-head">
        <div className="ticket-head-main">
          <div className="ticket-id-row">
            <span className="mono ticket-number">#{ticket.number}</span>
            <span className={`status-pill status-${ticket.status}`}>{STATUS_LABELS[ticket.status] ?? ticket.status}</span>
            <span className="mono priority-mark">{ticket.priority.toUpperCase()}</span>
            <span className={`sla-chip sla-${sla.tone}`}>{sla.label}</span>
          </div>
          <h1 className="ticket-subject">{ticket.subject}</h1>
          <div className="ticket-meta mono">
            opened {formatWhen(ticket.created_at)} · requester {ticket.requester_name ?? '—'} ·
            assignee {ticket.assignee_name ?? 'unassigned'}
          </div>
        </div>
        <div className="ticket-actions">
          {ticket.assignee_id !== auth.user?.id || !lockIsMine ? (
            <button className="btn btn-primary btn-sm" onClick={() => void assignToMe()} disabled={readOnlyForLock}>
              {ticket.assignee_id === auth.user?.id ? 'Claim & lock' : 'Assign to me'}
            </button>
          ) : null}
          <select
            className="field-input select-sm"
            value={ticket.status}
            onChange={(e) => void changeStatus(e.target.value)}
            disabled={readOnlyForLock}
            aria-label="Status"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{STATUS_LABELS[s]}</option>
            ))}
          </select>
          <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock} onClick={() => { setShowEscalate(!showEscalate); setShowForward(false) }}>
            ⬆ Escalate
          </button>
          <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock} onClick={() => { setShowForward(!showForward); setShowEscalate(false) }}>
            ➤ Forward
          </button>
        </div>

        {/* Escalation form */}
        {showEscalate && (
          <div className="ticket-escalate-form">
            <h4 className="ticket-escalate-title">Escalate ticket</h4>
            <select className="field-input select-sm" value={escTeam} onChange={(e) => setEscTeam(e.target.value)}>
              <option value="">Keep current team</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <textarea className="field-input" placeholder="Reason for escalation (required)" value={escReason} onChange={(e) => setEscReason(e.target.value)} rows={2} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={() => void handleEscalate()} disabled={escBusy || !escReason.trim()}>
                {escBusy ? 'Escalating…' : 'Escalate'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowEscalate(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Forward form */}
        {showForward && (
          <div className="ticket-escalate-form">
            <h4 className="ticket-escalate-title">Forward to team</h4>
            <select className="field-input select-sm" value={fwdTeam} onChange={(e) => setFwdTeam(e.target.value)}>
              <option value="">Select a team…</option>
              {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <textarea className="field-input" placeholder="Note (optional)" value={fwdNote} onChange={(e) => setFwdNote(e.target.value)} rows={2} />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={() => void handleForward()} disabled={fwdBusy || !fwdTeam}>
                {fwdBusy ? 'Forwarding…' : 'Forward'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowForward(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Escalation history */}
        {escalations.length > 0 && (
          <div className="ticket-escalation-history">
            <span className="etch">Escalation history</span>
            {escalations.map((e) => (
              <div key={e.id} className="ticket-escalation-entry">
                <span className="ticket-esc-level">Level {e.level}</span>
                <span className="ticket-esc-reason">{e.reason}</span>
                <span className="ticket-esc-meta">by {e.escalated_by_name || 'Unknown'} · {formatWhen(e.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {/* Compact lock and viewer status indicators */}
      <div className="ticket-presence-status" aria-label="Ticket presence status">
        <span
          className={`ticket-status-icon ${ticketLock ? 'is-locked' : 'is-unlocked'}`}
          data-tooltip={ticketLock
            ? `${lockIsMine ? 'Locked to' : 'Locked by'} ${ticketLock.locked_by_name || ticketLock.locked_by_email}`
            : 'Unlocked'}
          tabIndex={0}
        >
          <Icon name={ticketLock ? 'lock' : 'unlock'} size={17} />
          <span className="sr-only">{ticketLock ? `${lockIsMine ? 'Locked to' : 'Locked by'} ${ticketLock.locked_by_name || ticketLock.locked_by_email}` : 'Unlocked'}</span>
        </span>
        {ticketLock && canOverrideTicketLock && !lockIsMine ? (
          <button
            type="button"
            className="ticket-status-icon ticket-status-action"
            onClick={() => void handleForceUnlock()}
            disabled={lockBusy}
            data-tooltip="Force unlock ticket"
            aria-label="Force unlock ticket"
          >
            <Icon name="unlock" size={16} />
          </button>
        ) : null}
        <span
          className={`ticket-status-icon ${viewers.length > 0 ? 'is-viewing' : 'is-not-viewing'}`}
          data-tooltip={viewers.length > 0
            ? `Viewing: ${viewers.map((viewer) => viewer.name || viewer.email).join(', ')}`
            : 'Not being viewed'}
          tabIndex={0}
        >
          <Icon name={viewers.length > 0 ? 'eye' : 'eye-off'} size={17} />
          <span className="sr-only">{viewers.length > 0 ? `Viewing: ${viewers.map((viewer) => viewer.name || viewer.email).join(', ')}` : 'Not being viewed'}</span>
        </span>
      </div>

      <section className="ticket-device-context">
        <div>
          <span className="etch">Endpoint context</span>
          {ticketDevice ? (
            <Link to={`/devices/${ticketDevice.id}`} className="ticket-device-summary">
              <span className="device-avatar">{ticketDevice.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{ticketDevice.name}</strong><small>{ticketDevice.hostname || ticketDevice.os || 'Device details'}</small></span>
            </Link>
          ) : <span className="muted">No device linked to this ticket.</span>}
        </div>
        <select
          className="field-input select-sm"
          value={ticket.device_id ?? ''}
          onChange={(event) => void changeDevice(event.target.value)}
          disabled={deviceSaving || readOnlyForLock}
          aria-label="Linked device"
        >
          <option value="">No device linked</option>
          {ticketDevice && !devices.some((device) => device.id === ticketDevice.id) ? <option value={ticketDevice.id}>{ticketDevice.name}</option> : null}
          {devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.hostname ? ` · ${device.hostname}` : ''}</option>)}
        </select>
      </section>

      {extKeys.length > 0 ? (
        <section className="ticket-ext">
          <span className="etch">Details</span>
          {extKeys.map((k) => (
            <div key={k} className="ticket-ext-row">
              <span className="muted">{extLabel[k] ?? k}</span>
              <span>{String(ext[k])}</span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="ticket-links">
        <span className="etch">Linked items</span>
        {links.length === 0 ? (
          <span className="muted">No linked items.</span>
        ) : (
          <ul className="attachments-list">
            {links.map((l) => (
              <li key={l.id} className="attachment-row">
                <span className="mono muted">{l.link_type}</span>
                <span className="attachment-name">
                  {l.target_type === 'ticket'
                    ? `#${l.target_number} ${l.target_subject ?? ''}`
                    : l.target_type === 'asset'
                      ? (l.target_asset_name ?? 'asset')
                      : l.target_type === 'kb'
                        ? (l.target_kb_title ?? 'KB article')
                        : 'session'}
                </span>
                <span className="muted mono">{l.target_type}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => void removeLink(l)}>Unlink</button>
              </li>
            ))}
          </ul>
        )}
        <div className="ticket-link-form">
          <select className="field-input select-sm" value={linkType} onChange={(e) => setLinkType(e.target.value)} aria-label="Link type">
            <option value="related">Related</option>
            <option value="caused_by">Caused by</option>
            <option value="parent">Parent</option>
            <option value="child">Child</option>
            <option value="duplicates">Duplicates</option>
          </select>
          <select className="field-input select-sm" value={linkTargetType} onChange={(e) => setLinkTargetType(e.target.value)} aria-label="Target type">
            <option value="ticket">Ticket</option>
            <option value="asset">Asset</option>
            <option value="kb">KB article</option>
            <option value="session">Session</option>
          </select>
          <input className="field-input mono" value={linkTargetId} onChange={(e) => setLinkTargetId(e.target.value)} placeholder="target id" />
          <button className="btn btn-ghost btn-sm" disabled={!linkTargetId.trim()} onClick={() => void addLink()}>Link</button>
        </div>
      </section>

      {canUseAi ? (
        <section className="ticket-links ai-panel">
          <div className="attachments-head">
            <span className="etch">AI assistant</span>
            {aiTriage ? <span className={`status-pill status-${aiTriage.status === 'resolved' ? 'resolved' : aiTriage.status === 'handoff' ? 'escalated' : aiTriage.status === 'waiting_for_user' ? 'pending_user' : 'open'}`}>{aiTriage.status.replace('_', ' ')}</span> : null}
          </div>
          {aiTriage && aiTriage.status !== 'idle' ? <div className="ai-result"><span className="muted mono">Automatic triage · round {aiTriage.round}</span>{aiTriage.lastQuestion ? <p>{aiTriage.lastQuestion}</p> : null}{aiTriage.lastError ? <p className="muted">{aiTriage.lastError}</p> : null}<div className="ticket-link-form"><button className="btn btn-ghost btn-sm" disabled={aiTriageBusy || aiTriage.status === 'disabled' || aiTriage.status === 'resolved'} onClick={() => void runAiTriageAction('retry')}>Retry triage</button><button className="btn btn-ghost btn-sm" disabled={aiTriageBusy || aiTriage.status === 'disabled' || aiTriage.status === 'resolved'} onClick={() => void runAiTriageAction('stop')}>Stop AI</button></div></div> : null}
          <div className="ticket-link-form">
            <button className="btn btn-ghost btn-sm" disabled={aiSummaryBusy} onClick={() => void runAiSummary()}>
              {aiSummaryBusy ? 'Summarising…' : 'Summarise'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={aiSimilarBusy} onClick={() => void runAiSimilar()}>
              {aiSimilarBusy ? 'Searching…' : 'Similar incidents'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={aiDraftBusy} onClick={() => void runAiDraft()}>
              {aiDraftBusy ? 'Drafting…' : 'Draft KB article'}
            </button>
          </div>
          {aiSummary ? (
            <div className="ai-result">
              <span className="muted mono">AI summary · internal</span>
              <p>{aiSummary}</p>
            </div>
          ) : null}
          {aiSimilarDone ? (
            aiSimilar.length === 0 ? (
              <div className="muted" style={{ padding: '4px 0' }}>No similar incidents found.</div>
            ) : (
              <ul className="attachments-list">
                {aiSimilar.map((s) => (
                  <li key={s.id} className="attachment-row">
                    <Link className="attachment-link" to={`/tickets/${s.id}`}>
                      <span className="attachment-name">#{s.number} {s.subject}</span>
                    </Link>
                    <span className="muted mono">{s.type} · {s.status} · {(s.similarity * 100).toFixed(0)}% match</span>
                  </li>
                ))}
              </ul>
            )
          ) : null}
          {aiDraft ? (
            <div className="ai-result">
              <span className="muted mono">Draft KB article · {aiDraft.status}</span>
              <p><strong>{aiDraft.title}</strong></p>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="timeline">
        {threads.map((th) => (
          <div key={th.id} className={`timeline-entry kind-${th.kind}`}>
            <div className="timeline-meta mono">
              {th.kind === 'system_event' ? (
                <span>{th.body} · {formatWhen(th.created_at)}</span>
              ) : (
                <>
                  <span className="timeline-author">{th.author_name ?? 'System'}</span>
                  <span>{th.kind === 'internal_note' ? 'internal note' : th.kind === 'session_record' ? 'session' : th.kind === 'ai_triage' ? 'AI assistant' : 'message'}</span>
                  <span>{formatWhen(th.created_at)}</span>
                </>
              )}
            </div>
            {th.kind !== 'system_event' ? <div className="timeline-body">{th.body}</div> : null}
          </div>
        ))}
      </div>

      <div className="attachments">
        <div className="attachments-head">
          <span className="etch">Attachments</span>
          <label className="btn btn-ghost btn-sm" title="Attach a file">
            {uploading ? 'Uploading…' : 'Add file'}
            <input type="file" hidden onChange={(e) => void onUpload(e)} />
          </label>
        </div>
        {uploadError ? <div className="alert alert-error" style={{ margin: '8px 0' }}>{uploadError}</div> : null}
        {attachments.length === 0 ? (
          <div className="muted" style={{ padding: '4px 0' }}>No files attached.</div>
        ) : (
          <ul className="attachments-list">
            {attachments.map((a) => (
              <li key={a.id} className="attachment-row">
                <button
                  className="attachment-link"
                  onClick={() => void downloadAttachment(getAccessToken() ?? '', a.id, a.filename)}
                  title="Download"
                >
                  <span className="attachment-icon">📎</span>
                  <span className="attachment-name">{a.filename}</span>
                </button>
                <span className="muted mono">{Math.max(1, Math.round(a.size_bytes / 1024))} KB · {a.uploader_name ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>{/* end ticket-detail-scroll */}

      <div className="composer ticket-composer-fixed">
        <div className="composer-tabs">
          <button
            className={`composer-tab${composerMode === 'public' ? ' active' : ''}`}
            onClick={() => setComposerMode('public')}
          >
            Reply
          </button>
          <button
            className={`composer-tab${composerMode === 'internal' ? ' active' : ''}`}
            onClick={() => setComposerMode('internal')}
          >
            Internal note
          </button>
          {canned.length > 0 ? (
            <button
              className={`composer-tab${showCanned ? ' active' : ''}`}
              onClick={() => setShowCanned((s) => !s)}
              aria-expanded={showCanned}
            >
              Templates
            </button>
          ) : null}
        </div>
        {showCanned ? (
          <div className="canned-picker">
            <input
              className="field-input canned-search"
              placeholder="Search templates…"
              value={cannedQuery}
              onChange={(e) => setCannedQuery(e.target.value)}
              autoFocus
            />
            <ul className="canned-list">
              {canned
                .filter((c) => {
                  const q = cannedQuery.toLowerCase()
                  return !q || c.name.toLowerCase().includes(q) || c.shortcut.toLowerCase().includes(q) || c.body.toLowerCase().includes(q)
                })
                .map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      className="canned-item"
                      onClick={() => {
                        setDraft(c.body)
                        setShowCanned(false)
                      }}
                    >
                      <span className="canned-item-name">{c.name}</span>
                      <span className="canned-item-shortcut mono">/{c.shortcut}</span>
                    </button>
                  </li>
                ))}
              {canned.length > 0 && canned.every((c) => {
                const q = cannedQuery.toLowerCase()
                return q && !c.name.toLowerCase().includes(q) && !c.shortcut.toLowerCase().includes(q) && !c.body.toLowerCase().includes(q)
              }) ? (
                <li className="muted" style={{ padding: '8px 12px' }}>No matching templates.</li>
              ) : null}
            </ul>
          </div>
        ) : null}
        <textarea
          className="composer-input"
          rows={4}
          placeholder={composerMode === 'public' ? 'Reply to the requester…' : 'Add a private note for technicians…'}
          value={draft}
          disabled={readOnlyForLock}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void sendReply()
          }}
        />
        <div className="composer-foot">
          <span className="etch">{readOnlyForLock ? 'Read-only while another agent is working' : 'Ctrl+Enter to send'}</span>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || readOnlyForLock || !draft.trim()}
            onClick={() => void sendReply()}
          >
            {composerMode === 'public' ? 'Send reply' : 'Add note'}
          </button>
        </div>
      </div>
      </div>{/* end ticket-detail-layout */}
    </Shell>
  )
}
