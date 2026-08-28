import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, Modal } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { getAccessToken } from '../lib/api.js'
import { useAuth } from '../lib/auth.js'
import {
  addTicketLink, assignTicket, getTicket, listTicketLinks, removeTicketLink, replyTicket, setTicketStatus,
  downloadAttachment, listAttachments, updateTicket, uploadAttachment,
  escalateTicket, getTicketEscalations, getTicketEscalationPaths, forwardTicket, listTeams, listTeamMembers,
  getTicketLock, lockTicket, unlockTicket, heartbeatLock, forceUnlockTicket,
  listLockReleaseRequests, requestTicketLockRelease, resolveLockReleaseRequest,
  listActiveTicketLocks,
  startViewingTicket, stopViewingTicket, heartbeatViewing, getTicketViewers,
  slaSummary, STATUS_LABELS, formatWhen, fetchAttachmentBlob, searchLinkTargets,
  listTicketReminders, createTicketReminder, updateTicketReminder, dismissTicketReminder, deleteTicketReminder,
  type Attachment, type Thread, type Ticket, type TicketDevice, type TicketLink, type LinkSearchResult,
  type Escalation, type EscalationPath, type Team, type TicketLockInfo, type LockReleaseRequest, type LockedTicketSummary,
  type TicketReminder,
} from '../lib/tickets.js'
import { listCannedResponses, type CannedResponse } from '../lib/canned.js'
import '../styles/ticket-lock.css'
import { listDevices, type Device } from '../lib/devices.js'
import { draftKbArticle, getTriageState, listSimilarTickets, retryTriage, stopTriage, summarizeTicket, type KbDraftArticle, type SimilarTicket, type TriageState } from '../lib/ai.js'

const STATUS_OPTIONS = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated', 'resolved', 'closed']

function displayTicketValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unavailable]'
  }
}

/** Format a Date as a local `datetime-local` input value (YYYY-MM-DDTHH:mm). */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function TicketDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const auth = useAuth()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [ticketDevice, setTicketDevice] = useState<TicketDevice | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [threads, setThreads] = useState<Thread[]>([])
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const dragCounterRef = useRef(0)
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
  const [linkTargetLabel, setLinkTargetLabel] = useState('')
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState<LinkSearchResult[]>([])
  const [linkSearchOpen, setLinkSearchOpen] = useState(false)
  const [linkSearching, setLinkSearching] = useState(false)
  const [showLinkForm, setShowLinkForm] = useState(false)
  const linkDebounceRef = useRef<number | undefined>(undefined)

  // Image preview (zoom + download for image attachments)
  const [previewImage, setPreviewImage] = useState<{ id: string; filename: string; url: string } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewZoom, setPreviewZoom] = useState(1)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)

  // Inline thumbnails for image attachments in the list.
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const thumbUrlsRef = useRef<Record<string, string>>({})
  const thumbLoadedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const pending = attachments.filter((a) => (a.mime ?? '').startsWith('image/') && !thumbLoadedRef.current.has(a.id))
    void Promise.all(pending.map(async (a) => {
      try {
        const url = await fetchAttachmentBlob(getAccessToken() ?? '', a.id)
        return { id: a.id, url } as const
      } catch {
        return null
      }
    })).then((results) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const result of results) {
        if (!result) continue
        next[result.id] = result.url
        thumbLoadedRef.current.add(result.id)
        thumbUrlsRef.current[result.id] = result.url
      }
      if (Object.keys(next).length > 0) setThumbnails((prev) => ({ ...prev, ...next }))
    })
    return () => { cancelled = true }
  }, [id, attachments])

  useEffect(() => () => {
    for (const url of Object.values(thumbUrlsRef.current)) URL.revokeObjectURL(url)
    thumbUrlsRef.current = {}
    thumbLoadedRef.current.clear()
  }, [])

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
  const [releaseRequests, setReleaseRequests] = useState<LockReleaseRequest[]>([])
  const [releaseBusy, setReleaseBusy] = useState(false)
  const [showLockModal, setShowLockModal] = useState(false)
  const [allLocks, setAllLocks] = useState<LockedTicketSummary[]>([])
  const [allLocksBusy, setAllLocksBusy] = useState(false)
  const [viewers, setViewers] = useState<Array<{ user_id: string; name: string; email: string; viewing_at: string }>>([])

  // Escalation & forward
  const [escalations, setEscalations] = useState<Escalation[]>([])
  const [teams, setTeams] = useState<Team[]>([])
  const [escTeam, setEscTeam] = useState('')
  const [escAssignee, setEscAssignee] = useState('')
  const [escReason, setEscReason] = useState('')
  const [escBusy, setEscBusy] = useState(false)
  const [escPaths, setEscPaths] = useState<EscalationPath[]>([])
  const [escPathsLoaded, setEscPathsLoaded] = useState(false)
  const [fwdTeam, setFwdTeam] = useState('')
  const [fwdNote, setFwdNote] = useState('')
  const [fwdBusy, setFwdBusy] = useState(false)
  const [showEscalate, setShowEscalate] = useState(false)
  const [showForward, setShowForward] = useState(false)
  const [showReminder, setShowReminder] = useState(false)
  const [reminders, setReminders] = useState<TicketReminder[]>([])
  const [reminderNote, setReminderNote] = useState('')
  const [reminderDue, setReminderDue] = useState('')
  const [reminderBusy, setReminderBusy] = useState(false)
  const [dueReminder, setDueReminder] = useState<TicketReminder | null>(null)

  const canUseAi = useAuth((state) => state.memberships.some((m) => m.permissions.includes('ai.use')))
  const canOverrideTicketLock = auth.memberships.some((m) => m.permissions.includes('settings.manage'))

  const load = useCallback(async () => {
    if (!id) return
    try {
      // Register this browser as a viewer before deciding whether an assigned
      // ticket can be locked. A ticket assigned to this agent is automatically
      // locked on entry only when nobody else is currently viewing it.
      await startViewingTicket(id).catch(() => {})
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
      try {
        setReminders((await listTicketReminders(id)).reminders)
      } catch { setReminders([]) }

      let activeLock: TicketLockInfo | null = null
      let activeLockIsMine = false
      try {
        const lockRes = await getTicketLock(id)
        activeLock = lockRes.lock
        activeLockIsMine = lockRes.is_mine
      } catch {
        activeLock = null
        activeLockIsMine = false
      }

      let currentViewers: Array<{ user_id: string; name: string; email: string; viewing_at: string }> = []
      try {
        currentViewers = (await getTicketViewers(id)).viewers
        setViewers(currentViewers)
      } catch { /* ignore */ }

      const otherViewers = currentViewers.filter((viewer) => viewer.user_id !== auth.user?.id)
      if (res.ticket.assignee_id === auth.user?.id && !activeLock && otherViewers.length === 0) {
        try {
          activeLock = (await lockTicket(id)).lock
          activeLockIsMine = true
        } catch {
          // Another agent may have claimed the lock between the viewer check
          // and acquisition. Refresh so the detail page becomes read-only.
          try {
            const latest = await getTicketLock(id)
            activeLock = latest.lock
            activeLockIsMine = latest.is_mine
          } catch { /* ignore transient lock races */ }
        }
      }
      setTicketLock(activeLock)
      setLockIsMine(activeLockIsMine)

      try {
        setReleaseRequests((await listLockReleaseRequests(id)).requests)
      } catch { setReleaseRequests([]) }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ticket')
    }
  }, [id, auth.user?.id])

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
    const checkDueReminder = () => {
      const due = reminders.find((reminder) => Boolean(reminder.fired_at && !reminder.dismissed_at)) ?? null
      setDueReminder(due)
    }
    checkDueReminder()
    const interval = window.setInterval(checkDueReminder, 15_000)
    return () => window.clearInterval(interval)
  }, [reminders])

  useEffect(() => {
    if (!id) return
    const interval = setInterval(() => {
      heartbeatLock(id).catch(() => {})
      heartbeatViewing(id).catch(() => {})
    }, 25_000)
    return () => clearInterval(interval)
  }, [id])

  // Poll presence (lock, viewers, and release requests) on a short cadence so
  // a release request or approval reaches the other agent promptly without a
  // full page reload.
  useEffect(() => {
    if (!id) return
    const refreshPresence = async () => {
      try {
        const result = await getTicketLock(id)
        setTicketLock(result.lock)
        setLockIsMine(result.is_mine)
      } catch { /* ignore transient refresh failures */ }
      try {
        const res = await getTicketViewers(id)
        setViewers(res.viewers)
      } catch { /* ignore */ }
      try {
        setReleaseRequests((await listLockReleaseRequests(id)).requests)
      } catch { /* ignore */ }
    }
    const interval = setInterval(refreshPresence, 3_000)
    return () => clearInterval(interval)
  }, [id])

  useEffect(() => {
    if (!id) return
    return () => {
      void stopViewingTicket(id)
      void unlockTicket(id)
    }
  }, [id])

  // Debounced search for link targets (ticket / asset / kb).
  useEffect(() => {
    const q = linkQuery.trim()
    if (q.length < 1 || linkTargetLabel) {
      setLinkResults([])
      setLinkSearchOpen(false)
      setLinkSearching(false)
      return
    }
    setLinkSearching(true)
    window.clearTimeout(linkDebounceRef.current)
    linkDebounceRef.current = window.setTimeout(() => {
      searchLinkTargets(linkTargetType, q)
        .then((res) => {
          setLinkResults(res.results)
          setLinkSearchOpen(true)
        })
        .catch(() => {
          setLinkResults([])
          setLinkSearchOpen(true)
        })
        .finally(() => setLinkSearching(false))
    }, 250)
    return () => window.clearTimeout(linkDebounceRef.current)
  }, [linkQuery, linkTargetType, linkTargetLabel])

  // Keyboard shortcuts for the image viewer — placed before the early returns
  // so that hook order is stable across loading and loaded states.
  const ZOOM_MIN = 0.25
  const ZOOM_MAX = 3
  const ZOOM_STEP = 0.25
  const zoomIn = () => setPreviewZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
  const zoomOut = () => setPreviewZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))
  const zoomReset = () => setPreviewZoom(1)

  useEffect(() => {
    if (!previewImage || previewLoading) return
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (event.key === 'Escape') {
        event.preventDefault()
        if (previewFullscreen) setPreviewFullscreen(false)
        else {
          if (previewImage) URL.revokeObjectURL(previewImage.url)
          setPreviewImage(null)
          setPreviewZoom(1)
          setPreviewFullscreen(false)
        }
      } else if (event.key === 'f' || event.key === 'F') {
        setPreviewFullscreen((value) => !value)
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault()
        setPreviewZoom((z) => Math.min(ZOOM_MAX, Math.round((z + ZOOM_STEP) * 100) / 100))
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault()
        setPreviewZoom((z) => Math.max(ZOOM_MIN, Math.round((z - ZOOM_STEP) * 100) / 100))
      } else if (event.key === '0') {
        setPreviewZoom(1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewImage, previewLoading, previewFullscreen])

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
  const assignedToMe = ticket.assignee_id === auth.user?.id
  const otherViewers = viewers.filter((viewer) => viewer.user_id !== auth.user?.id)
  const blockedByAnotherViewer = assignedToMe && otherViewers.length > 0 && !lockIsMine && !canOverrideTicketLock
  const readOnlyForLock = Boolean((ticketLock && !lockIsMine && !canOverrideTicketLock) || blockedByAnotherViewer)
  const blockingName = ticketLock?.locked_by_name ?? ticketLock?.locked_by_email ?? otherViewers[0]?.name ?? otherViewers[0]?.email ?? 'Another agent'
  // Pulse the padlock while another agent is waiting for me to release the
  // lock, and while my own release request is still awaiting a response.
  const hasPendingReleaseRequest = releaseRequests.some((request) => request.status === 'pending' && request.locked_by === auth.user?.id)
  const myPendingReleaseRequest = releaseRequests.some((request) => request.status === 'pending' && request.requested_by === auth.user?.id)
  const lockIconPulsing = hasPendingReleaseRequest || myPendingReleaseRequest

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

  const openEscalate = () => {
    const next = !showEscalate
    setShowEscalate(next)
    setShowForward(false)
    if (next && !escPathsLoaded) {
      getTicketEscalationPaths(ticket.id)
        .then((result) => setEscPaths(result.paths))
        .catch(() => setEscPaths([]))
        .finally(() => setEscPathsLoaded(true))
    }
  }

  const chooseEscalationPath = (path: EscalationPath) => {
    setEscTeam(path.target_team_id)
    setEscAssignee(path.auto_assign ? (path.target_assignee_id ?? '') : '')
    setEscReason(path.description || `Escalate via ${path.name}`)
  }

  const handleEscalate = async () => {
    if (!ticket || !escReason.trim()) return
    setEscBusy(true)
    try {
      await escalateTicket(ticket.id, { to_team_id: escTeam || undefined, to_assignee_id: escAssignee || undefined, reason: escReason })
      setEscReason('')
      setEscTeam('')
      setEscAssignee('')
      setEscPaths([])
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

  // ── Reminder handlers ──
  const openReminder = () => {
    const next = !showReminder
    setShowReminder(next)
    setShowEscalate(false)
    setShowForward(false)
    if (next && !reminderDue) {
      // Default to +2 hours from now.
      const d = new Date(Date.now() + 2 * 60 * 60 * 1000)
      setReminderDue(toLocalInputValue(d))
    }
  }

  const handleCreateReminder = async () => {
    if (!ticket || !reminderDue || reminderBusy) return
    setReminderBusy(true)
    try {
      await createTicketReminder(ticket.id, { dueAt: new Date(reminderDue).toISOString(), note: reminderNote.trim() })
      setReminderNote('')
      setReminders((await listTicketReminders(ticket.id)).reminders)
      setShowReminder(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set reminder')
    }
    setReminderBusy(false)
  }

  const handleSnoozeReminder = async (reminder: TicketReminder) => {
    try {
      // Re-arm a fired reminder for +30 minutes.
      const d = new Date(Date.now() + 30 * 60 * 1000)
      await updateTicketReminder(reminder.id, { dueAt: d.toISOString() })
      setReminders((await listTicketReminders(ticket!.id)).reminders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not snooze reminder')
    }
  }

  const handleDismissReminder = async (reminder: TicketReminder) => {
    try {
      await dismissTicketReminder(reminder.id)
      setReminders((await listTicketReminders(ticket!.id)).reminders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dismiss reminder')
    }
  }

  const handleDeleteReminder = async (reminder: TicketReminder) => {
    try {
      await deleteTicketReminder(reminder.id)
      setReminders((await listTicketReminders(ticket!.id)).reminders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete reminder')
    }
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

  const handleRequestRelease = async () => {
    if (!ticket || lockIsMine || releaseBusy) return
    setReleaseBusy(true)
    setError(null)
    try {
      const result = await requestTicketLockRelease(ticket.id, 'Please release this ticket when you are finished so I can continue.')
      setReleaseRequests((current) => [result.request, ...current.filter((request) => request.id !== result.request.id)])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request lock release')
    } finally {
      setReleaseBusy(false)
    }
  }

  const handleResolveRelease = async (request: LockReleaseRequest, decision: 'approve' | 'deny') => {
    if (!ticket || releaseBusy) return
    setReleaseBusy(true)
    setError(null)
    try {
      const result = await resolveLockReleaseRequest(ticket.id, request.id, decision)
      setReleaseRequests((current) => current.map((item) => item.id === result.request.id ? result.request : item))
      if (decision === 'approve') {
        setTicketLock(null)
        setLockIsMine(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resolve lock request')
    } finally {
      setReleaseBusy(false)
    }
  }

  const loadAllLocks = async () => {
    if (!canOverrideTicketLock || allLocksBusy) return
    setAllLocksBusy(true)
    try {
      setAllLocks((await listActiveTicketLocks()).locks)
    } catch { /* ignore transient load failures */ }
    setAllLocksBusy(false)
  }

  const releaseAnyLock = async (ticketId: string) => {
    setLockBusy(true)
    try {
      await forceUnlockTicket(ticketId)
      setAllLocks((current) => current.filter((lock) => lock.ticket_id !== ticketId))
      if (ticketId === ticket?.id) {
        setTicketLock(null)
        setLockIsMine(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not release lock')
    } finally {
      setLockBusy(false)
    }
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

  const uploadFiles = async (files: File[]) => {
    if (!ticket || files.length === 0 || uploading) return
    setUploading(true)
    setUploadError(null)
    try {
      for (const file of files) {
        await uploadAttachment(getAccessToken() ?? '', ticket.id, file)
      }
      await load()
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void uploadFiles(files)
  }

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    if (readOnlyForLock) return
    dragCounterRef.current += 1
    setDragActive(true)
  }

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
  }

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragActive(false)
    if (readOnlyForLock) return
    void uploadFiles(Array.from(e.dataTransfer.files))
  }

  const addLink = async () => {
    if (!ticket || !linkTargetId.trim()) return
    setError(null)
    try {
      await addTicketLink(ticket.id, { linkType, targetType: linkTargetType, targetId: linkTargetId.trim() })
      setLinkTargetId('')
      setLinkTargetLabel('')
      setShowLinkForm(false)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link')
    }
  }

  const selectLinkTarget = (result: LinkSearchResult) => {
    setLinkTargetId(result.id)
    setLinkTargetLabel(result.label)
    setLinkQuery('')
    setLinkResults([])
    setLinkSearchOpen(false)
  }

  const clearLinkTarget = () => {
    setLinkTargetId('')
    setLinkTargetLabel('')
    setLinkQuery('')
    setLinkResults([])
  }

  const changeLinkTargetType = (type: string) => {
    setLinkTargetType(type)
    clearLinkTarget()
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

  const isImageAttachment = (attachment: Attachment) => (attachment.mime ?? '').startsWith('image/')

  const openImagePreview = async (attachment: Attachment) => {
    setPreviewLoading(true)
    setError(null)
    try {
      const url = await fetchAttachmentBlob(getAccessToken() ?? '', attachment.id)
      setPreviewZoom(1)
      setPreviewFullscreen(false)
      setPreviewImage({ id: attachment.id, filename: attachment.filename, url })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load image')
    } finally {
      setPreviewLoading(false)
    }
  }

  const closeImagePreview = () => {
    if (previewImage) URL.revokeObjectURL(previewImage.url)
    setPreviewImage(null)
    setPreviewZoom(1)
    setPreviewFullscreen(false)
  }

  const viewerStage = previewImage ? (
    <div className="image-viewer-stage" onDoubleClick={() => setPreviewFullscreen((value) => !value)} onWheel={(event) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      if (event.deltaY < 0) zoomIn()
      else zoomOut()
    }}>
      <img src={previewImage.url} alt={previewImage.filename} style={{ width: `${previewZoom * 100}%` }} draggable={false} />
    </div>
  ) : null

  const viewerToolbar = previewImage ? (
    <div className="image-viewer-toolbar">
      <button type="button" className="btn btn-ghost btn-sm" onClick={zoomOut} title="Zoom out (−)" aria-label="Zoom out"><Icon name="minus" size={14} /></button>
      <span className="mono">{Math.round(previewZoom * 100)}%</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={zoomIn} title="Zoom in (+)" aria-label="Zoom in"><Icon name="add" size={14} /></button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={zoomReset} title="Reset zoom (0)">Reset</button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreviewFullscreen((value) => !value)} title={previewFullscreen ? 'Exit full screen (F)' : 'Full screen (F)'} aria-label="Toggle full screen"><Icon name="external" size={14} /></button>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void downloadAttachment(getAccessToken() ?? '', previewImage.id, previewImage.filename)}><Icon name="download" size={14} />Download</button>
    </div>
  ) : null

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
        await stopTriage(ticket.id)
        setAiTriage((await getTriageState(ticket.id)).triage)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI triage action failed')
    } finally {
      setAiTriageBusy(false)
    }
  }

  const ext = ticket.ext ?? {}
  // aiTriage has its own structured panel below; do not render its object
  // payload through String(), which would show as `[object Object]`.
  const extKeys = Object.keys(ext).filter((key) => key !== 'aiTriage')
  const extLabel: Record<string, string> = {
    rootCause: 'Root cause',
    workaround: 'Workaround',
    risk: 'Risk',
    implementationPlan: 'Implementation plan',
    backoutPlan: 'Backout plan',
    scheduledAt: 'Scheduled for',
  }
  const triageStatus = aiTriage && typeof aiTriage.status === 'string' ? aiTriage.status : 'unknown'
  const triageQuestion = aiTriage?.lastQuestion ? displayTicketValue(aiTriage.lastQuestion) : null
  const triageError = aiTriage?.lastError ? displayTicketValue(aiTriage.lastError) : null
  const triageTranscript = aiTriage?.transcript ?? []

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
            {ticket.csat ? (
              <span className="ticket-csat-badge" title={ticket.csat.comment ? `“${ticket.csat.comment}”` : 'Requester satisfaction rating'}>
                <Icon name="star" size={12} />
                {ticket.csat.rating}/5
              </span>
            ) : null}
          </div>
        </div>
        <div className="ticket-actions">
          {ticket.assignee_id !== auth.user?.id ? (
            <button className="btn btn-primary btn-sm" onClick={() => void assignToMe()} disabled={readOnlyForLock}>
              Assign to me
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
          <div className="ticket-action-menu">
            <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock} onClick={openEscalate} aria-expanded={showEscalate}>
              <Icon name="activity" size={14} />Escalate
            </button>
            {showEscalate && (
              <div className="ticket-escalate-form ticket-action-dropdown">
                <h4 className="ticket-escalate-title">Escalate ticket</h4>
                <p className="ticket-escalate-hint">Raise to a higher-level team with a reason.</p>
                {escPaths.length > 0 ? <div className="ticket-escalation-paths"><span className="etch">Recommended routes</span>{escPaths.map((path) => <button type="button" key={path.id} className={`ticket-escalation-path${escTeam === path.target_team_id ? ' active' : ''}`} onClick={() => chooseEscalationPath(path)}><span className="ticket-escalation-path-name">{path.name}</span><span className="ticket-escalation-path-target">→ {path.target_team_name || 'team'}</span></button>)}</div> : null}
                <select className="field-input select-sm" value={escTeam} onChange={(e) => setEscTeam(e.target.value)}><option value="">Keep current team</option>{teams.filter((t) => t.accepts_tickets !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                <textarea className="field-input" placeholder="Reason for escalation (required)" value={escReason} onChange={(e) => setEscReason(e.target.value)} rows={2} />
                <div className="ticket-action-form-buttons"><button className="btn btn-primary btn-sm" onClick={() => void handleEscalate()} disabled={escBusy || !escReason.trim()}>{escBusy ? 'Escalating…' : 'Escalate'}</button><button className="btn btn-ghost btn-sm" onClick={() => setShowEscalate(false)}>Cancel</button></div>
              </div>
            )}
          </div>
          <div className="ticket-action-menu">
            <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock} onClick={() => { setShowForward(!showForward); setShowEscalate(false); setShowReminder(false) }} aria-expanded={showForward}>
              <Icon name="forward" size={14} />Forward
            </button>
            {showForward && (
              <div className="ticket-escalate-form ticket-action-dropdown">
                <h4 className="ticket-escalate-title">Forward to another team</h4>
                <p className="ticket-escalate-hint">Hand this ticket to the correct team.</p>
                <select className="field-input select-sm" value={fwdTeam} onChange={(e) => setFwdTeam(e.target.value)}><option value="">Select a team…</option>{teams.filter((t) => t.accepts_tickets !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
                <textarea className="field-input" placeholder="Note (optional)" value={fwdNote} onChange={(e) => setFwdNote(e.target.value)} rows={2} />
                <div className="ticket-action-form-buttons"><button className="btn btn-primary btn-sm" onClick={() => void handleForward()} disabled={fwdBusy || !fwdTeam}>{fwdBusy ? 'Forwarding…' : 'Forward'}</button><button className="btn btn-ghost btn-sm" onClick={() => setShowForward(false)}>Cancel</button></div>
              </div>
            )}
          </div>
          <div className="ticket-action-menu">
            <button className={`btn btn-ghost btn-sm${reminders.some((r) => !r.dismissed_at) ? ' btn-reminder-active' : ''}`} disabled={readOnlyForLock} onClick={openReminder} aria-expanded={showReminder}>
              <Icon name="bell" size={14} />Reminder{reminders.some((r) => !r.dismissed_at) ? ` (${reminders.filter((r) => !r.dismissed_at).length})` : ''}
            </button>
            {showReminder && (
              <div className="ticket-escalate-form ticket-action-dropdown">
                <h4 className="ticket-escalate-title">Set a reminder</h4>
                <p className="ticket-escalate-hint">Choose when to follow up on this ticket.</p>
                <div className="form-row"><div className="field"><span className="field-label">When</span><input className="field-input" type="datetime-local" value={reminderDue} onChange={(e) => setReminderDue(e.target.value)} /></div><div className="field" style={{ flex: 2 }}><span className="field-label">Note</span><input className="field-input" value={reminderNote} onChange={(e) => setReminderNote(e.target.value)} placeholder="e.g. Call back about VPN access" maxLength={500} /></div></div>
                <div className="ticket-action-form-buttons"><button className="btn btn-primary btn-sm" onClick={() => void handleCreateReminder()} disabled={reminderBusy || !reminderDue}>{reminderBusy ? 'Saving…' : 'Set reminder'}</button><button className="btn btn-ghost btn-sm" onClick={() => setShowReminder(false)}>Cancel</button></div>
                {reminders.length > 0 ? <div className="ticket-reminder-list"><span className="etch">Your reminders</span>{reminders.map((r) => { const fired = Boolean(r.fired_at && !r.dismissed_at); const dismissed = Boolean(r.dismissed_at); return <div key={r.id} className={`ticket-reminder-row${fired ? ' fired' : ''}${dismissed ? ' dismissed' : ''}`}><div className="ticket-reminder-main"><strong>{formatWhen(r.due_at)}</strong><span>{r.note || 'Follow up on this ticket'}</span></div><div className="ticket-reminder-actions">{fired ? <span className="status-pill status-warn">Due now</span> : null}{dismissed ? <span className="status-pill">Dismissed</span> : null}{!dismissed ? <button className="btn btn-ghost btn-xs" onClick={() => void handleSnoozeReminder(r)}>Snooze 30m</button> : null}{!dismissed ? <button className="btn btn-ghost btn-xs" onClick={() => void handleDismissReminder(r)}>Dismiss</button> : null}<button className="btn btn-ghost btn-xs" onClick={() => void handleDeleteReminder(r)} title="Delete"><Icon name="close" size={12} /></button></div></div> })}</div> : null}
              </div>
            )}
          </div>
        </div>

        {/* Legacy inline action panels removed; action forms now render as anchored dropdowns. */}
        {dueReminder ? (
          <aside className="ticket-reminder-flyout" role="alert" aria-live="assertive">
            <div className="ticket-reminder-flyout-head"><Icon name="bell" size={18} /><div><strong>Reminder due</strong><span>{dueReminder.note || 'Follow up on this ticket'}</span></div><button className="btn btn-ghost btn-xs" onClick={() => void handleDismissReminder(dueReminder)} aria-label="Dismiss reminder">Dismiss</button></div>
            <div className="ticket-reminder-flyout-actions"><button className="btn btn-primary btn-sm" onClick={() => void handleSnoozeReminder(dueReminder)}>Snooze 30 min</button><Link className="btn btn-ghost btn-sm" to="#ticket-timeline">Open ticket</Link></div>
          </aside>
        ) : null}

        {/* Escalation history */}
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
        {/* Removed stale inline action-panel fragment. */}
        {false && (
          <div className="ticket-escalate-form">
            <h4 className="ticket-escalate-title">Escalate ticket</h4>
            <p className="ticket-escalate-hint">Raise to a higher-level team with a reason. This bumps the escalation level and records a permanent entry in the escalation history.</p>
            {escPaths.length > 0 ? (
              <div className="ticket-escalation-paths">
                <span className="etch">Recommended routes</span>
                {escPaths.map((path) => (
                  <button type="button" key={path.id} className={`ticket-escalation-path${escTeam === path.target_team_id ? ' active' : ''}`} onClick={() => chooseEscalationPath(path)}>
                    <span className="ticket-escalation-path-name">{path.name}</span>
                    <span className="ticket-escalation-path-target">→ {path.target_team_name || 'team'}</span>
                  </button>
                ))}
              </div>
            ) : escPathsLoaded ? <div className="muted">No escalation routes match this ticket. Choose a team below.</div> : null}
            <select className="field-input select-sm" value={escTeam} onChange={(e) => setEscTeam(e.target.value)}>
              <option value="">Keep current team</option>
              {teams.filter((t) => t.accepts_tickets !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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
            <h4 className="ticket-escalate-title">Forward to another team</h4>
            <p className="ticket-escalate-hint">Hand this ticket to the correct team. No escalation level is raised and no escalation history entry is written — this is a simple hand-off.</p>
            <select className="field-input select-sm" value={fwdTeam} onChange={(e) => setFwdTeam(e.target.value)}>
              <option value="">Select a team…</option>
              {teams.filter((t) => t.accepts_tickets !== false).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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

        {showReminder && (
          <div className="ticket-escalate-form">
            <h4 className="ticket-escalate-title">Set a reminder</h4>
            <p className="ticket-escalate-hint">Remind yourself to follow up on this ticket later — when the user asks for a call-back, or you're waiting on an install to finish.</p>
            <div className="form-row">
              <div className="field">
                <span className="field-label">When</span>
                <input className="field-input" type="datetime-local" value={reminderDue} onChange={(e) => setReminderDue(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 2 }}>
                <span className="field-label">Note</span>
                <input className="field-input" value={reminderNote} onChange={(e) => setReminderNote(e.target.value)} placeholder="e.g. Call back about VPN access" maxLength={500} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={() => void handleCreateReminder()} disabled={reminderBusy || !reminderDue}>
                {reminderBusy ? 'Saving…' : 'Set reminder'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowReminder(false)}>Cancel</button>
            </div>
            {reminders.length > 0 ? (
              <div className="ticket-reminder-list">
                <span className="etch">Your reminders on this ticket</span>
                {reminders.map((r) => {
                  const fired = Boolean(r.fired_at && !r.dismissed_at)
                  const dismissed = Boolean(r.dismissed_at)
                  return (
                    <div key={r.id} className={`ticket-reminder-row${fired ? ' fired' : ''}${dismissed ? ' dismissed' : ''}`}>
                      <div className="ticket-reminder-main">
                        <strong>{formatWhen(r.due_at)}</strong>
                        <span>{r.note || 'Follow up on this ticket'}</span>
                      </div>
                      <div className="ticket-reminder-actions">
                        {fired ? <span className="status-pill status-warn">Due now</span> : null}
                        {dismissed ? <span className="status-pill">Dismissed</span> : null}
                        {!dismissed ? <button className="btn btn-ghost btn-xs" onClick={() => void handleSnoozeReminder(r)}>Snooze 30m</button> : null}
                        {!dismissed ? <button className="btn btn-ghost btn-xs" onClick={() => void handleDismissReminder(r)}>Dismiss</button> : null}
                        <button className="btn btn-ghost btn-xs" onClick={() => void handleDeleteReminder(r)} title="Delete"><Icon name="close" size={12} /></button>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      {/* Lock, viewer, and endpoint context on one compact row */}
      <div className="ticket-context-bar" aria-label="Ticket presence and endpoint context">
        <div className="ticket-presence-status">
        <button
          type="button"
          className={`ticket-status-icon ${ticketLock ? 'is-locked' : 'is-unlocked'}${lockIconPulsing ? ' has-release-request' : ''}`}
          onClick={() => { setShowLockModal(true); if (canOverrideTicketLock) void loadAllLocks() }}
          data-tooltip={hasPendingReleaseRequest
            ? 'Someone asked you to release this ticket · open to respond'
            : myPendingReleaseRequest
              ? 'You requested release · waiting for the agent'
              : ticketLock
                ? `${lockIsMine ? 'Locked to' : 'Locked by'} ${ticketLock.locked_by_name || ticketLock.locked_by_email} · manage lock`
                : 'Unlocked · manage lock'}
          aria-label={hasPendingReleaseRequest ? 'Lock release requested. Open lock actions.' : myPendingReleaseRequest ? 'You requested release. Open lock actions.' : ticketLock ? `Manage lock: ${lockIsMine ? 'locked to' : 'locked by'} ${ticketLock.locked_by_name || ticketLock.locked_by_email}` : 'Manage ticket lock'}
        >
          <Icon name={ticketLock ? 'lock' : 'unlock'} size={17} />
          <span className="sr-only">{ticketLock ? `${lockIsMine ? 'Locked to' : 'Locked by'} ${ticketLock.locked_by_name || ticketLock.locked_by_email}` : 'Unlocked'}</span>
        </button>
        {ticketLock && canOverrideTicketLock && !lockIsMine ? <span className="ticket-status-hint">Admin release available in lock actions</span> : null}
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
        <div className="ticket-endpoint-inline">
          <span className="etch">Endpoint</span>
          {ticketDevice ? (
            <Link to={`/devices/${ticketDevice.id}`} className="ticket-device-summary">
              <span className="device-avatar">{ticketDevice.name.slice(0, 1).toUpperCase()}</span>
              <span><strong>{ticketDevice.name}</strong><small>{ticketDevice.hostname || ticketDevice.os || 'Device details'}</small></span>
            </Link>
          ) : <span className="muted">No device linked</span>}
          <select
            className="field-input select-sm ticket-endpoint-select"
            value={ticket.device_id ?? ''}
            onChange={(event) => void changeDevice(event.target.value)}
            disabled={deviceSaving || readOnlyForLock}
            aria-label="Linked device"
          >
            <option value="">No device linked</option>
            {ticketDevice && !devices.some((device) => device.id === ticketDevice.id) ? <option value={ticketDevice.id}>{ticketDevice.name}</option> : null}
            {devices.map((device) => <option key={device.id} value={device.id}>{device.name}{device.hostname ? ` · ${device.hostname}` : ''}</option>)}
          </select>
        </div>
      </div>

      <Modal open={showLockModal} onClose={() => setShowLockModal(false)} title="Ticket lock" width={560}>
        <div className="ticket-lock-modal">
          <div className="ticket-lock-modal-state"><Icon name={ticketLock ? 'lock' : 'unlock'} size={20} /><div><strong>{ticketLock ? `${lockIsMine ? 'Locked to you' : `Locked by ${blockingName}`}` : 'Ticket is unlocked'}</strong><span>{ticketLock ? 'Only the current lock holder can edit this ticket.' : 'Assigning this ticket or opening your assigned ticket can claim the lock.'}</span></div></div>
          {readOnlyForLock && !lockIsMine ? <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleRequestRelease()} disabled={releaseBusy || releaseRequests.some((request) => request.status === 'pending' && request.requested_by === auth.user?.id)}><Icon name="send" size={14} />{releaseRequests.some((request) => request.status === 'pending' && request.requested_by === auth.user?.id) ? 'Release requested' : releaseBusy ? 'Requesting…' : 'Request release'}</button> : null}
          {ticketLock && canOverrideTicketLock && !lockIsMine ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => void handleForceUnlock()} disabled={lockBusy}><Icon name="unlock" size={14} />{lockBusy ? 'Releasing…' : 'Release lock as manager'}</button> : null}
          {releaseRequests.some((request) => request.status === 'pending' && request.locked_by === auth.user?.id) ? <div className="ticket-lock-modal-requests"><span className="etch">Requests from other agents</span>{releaseRequests.filter((request) => request.status === 'pending' && request.locked_by === auth.user?.id).map((request) => <div className="ticket-release-request" key={request.id}><div><strong>{request.requested_by_name ?? 'An agent'} wants to work on this ticket</strong><span className="muted">{request.message || 'They requested that you release the lock.'}</span></div><div className="ticket-release-request-actions"><button type="button" className="btn btn-primary btn-sm" disabled={releaseBusy} onClick={() => void handleResolveRelease(request, 'approve')}>Release lock</button><button type="button" className="btn btn-ghost btn-sm" disabled={releaseBusy} onClick={() => void handleResolveRelease(request, 'deny')}>Keep lock</button></div></div>)}</div> : null}
          {canOverrideTicketLock ? <div className="ticket-lock-modal-requests"><div className="ticket-lock-modal-allhead"><span className="etch">All locked tickets</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadAllLocks()} disabled={allLocksBusy}>{allLocksBusy ? 'Refreshing…' : 'Refresh'}</button></div>{allLocks.length === 0 ? <span className="muted">No tickets are currently locked.</span> : allLocks.map((lock) => <div className="ticket-release-request" key={lock.id}><div><strong><span className="mono">#{lock.ticket_number}</span> {lock.ticket_subject}</strong><span className="muted">Locked by {lock.locked_by_name ?? lock.locked_by_email ?? 'agent'} · expires {formatWhen(lock.expires_at)}</span></div><div className="ticket-release-request-actions"><button type="button" className="btn btn-ghost btn-sm" onClick={() => void releaseAnyLock(lock.ticket_id)} disabled={lockBusy}><Icon name="unlock" size={14} />Release</button></div></div>)}</div> : null}
        </div>
      </Modal>

      {extKeys.length > 0 ? (
        <section className="ticket-ext">
          <span className="etch">Details</span>
          {extKeys.map((k) => (
            <div key={k} className="ticket-ext-row">
              <span className="muted">{extLabel[k] ?? k}</span>
              <span>{displayTicketValue(ext[k])}</span>
            </div>
          ))}
        </section>
      ) : null}

      <section className="ticket-links">
        <div className="ticket-links-head">
          <div className="ticket-links-title">
            <span className="ticket-links-icon" aria-hidden="true"><Icon name="link" size={16} /></span>
            <div>
              <span className="etch">Linked items</span>
              <span className="ticket-links-summary">{links.length === 0 ? 'Connect this ticket to related work' : `${links.length} linked item${links.length === 1 ? '' : 's'}`}</span>
            </div>
          </div>
          <button
            type="button"
            className={`btn btn-ghost btn-sm ticket-link-trigger${showLinkForm ? ' active' : ''}`}
            onClick={() => setShowLinkForm((open) => !open)}
            aria-expanded={showLinkForm}
            aria-controls="ticket-link-form"
            aria-label={showLinkForm ? 'Close linking form' : 'Link a ticket or item'}
            title={showLinkForm ? 'Close linking form' : 'Link a ticket or item'}
            data-tooltip={showLinkForm ? 'Close linking form' : 'Link a ticket or item'}
            disabled={readOnlyForLock}
          >
            <Icon name="link" size={16} />
            <span>{showLinkForm ? 'Close' : 'Link item'}</span>
          </button>
        </div>
        {links.length === 0 ? (
          <div className="ticket-links-empty">
            <Icon name="link" size={18} />
            <span>No tickets or items linked yet.</span>
          </div>
        ) : (
          <ul className="attachments-list">
            {links.map((l) => (
              <li key={l.id} className="attachment-row">
                <span className="mono muted">{l.link_type}</span>
                <span className="attachment-name">
                  {l.target_type === 'ticket' ? (
                    <Link to={`/tickets/${l.target_id}`} className="ticket-link-item">
                      #{l.target_number} {l.target_subject ?? ''}
                    </Link>
                  ) : l.target_type === 'asset'
                    ? (l.target_asset_name ?? 'asset')
                    : l.target_type === 'kb'
                      ? (
                          <a href={`/kb/${l.target_id}`} className="ticket-link-item">
                            {l.target_kb_title ?? 'KB article'}
                          </a>
                        )
                      : 'session'}
                </span>
                <span className="muted mono">{l.target_type}</span>
                <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock} onClick={() => void removeLink(l)}>Unlink</button>
              </li>
            ))}
          </ul>
        )}
        {showLinkForm ? (
          <div className="ticket-link-form-panel" id="ticket-link-form">
            <div className="ticket-link-form-intro">
              <span className="ticket-links-icon" aria-hidden="true"><Icon name="link" size={15} /></span>
              <div>
                <strong>Link related work</strong>
                <span>Search and connect this ticket to another ticket, asset, or knowledge article.</span>
              </div>
            </div>
            <div className="ticket-link-form">
              <select className="field-input select-sm" value={linkType} onChange={(e) => setLinkType(e.target.value)} disabled={readOnlyForLock} aria-label="Link type">
                <option value="related">Related</option>
                <option value="caused_by">Caused by</option>
                <option value="parent">Parent</option>
                <option value="child">Child</option>
                <option value="duplicates">Duplicates</option>
              </select>
              <select className="field-input select-sm" value={linkTargetType} onChange={(e) => changeLinkTargetType(e.target.value)} disabled={readOnlyForLock} aria-label="Target type">
                <option value="ticket">Ticket</option>
                <option value="asset">Asset</option>
                <option value="kb">KB article</option>
              </select>
              <div className="link-target-search">
                {linkTargetLabel ? (
                  <div className="link-target-chip">
                    <span className="mono" title={linkTargetLabel}>{linkTargetLabel}</span>
                    <button type="button" className="link-target-chip-clear" onClick={clearLinkTarget} aria-label="Clear selection"><Icon name="close" size={13} /></button>
                  </div>
                ) : (
                  <>
                    <input
                      className="field-input mono"
                      value={linkQuery}
                      onChange={(e) => setLinkQuery(e.target.value)}
                      disabled={readOnlyForLock}
                      placeholder={`Search ${linkTargetType === 'kb' ? 'articles' : linkTargetType === 'asset' ? 'assets' : 'tickets'}…`}
                      aria-label="Search target"
                      onFocus={() => { if (linkResults.length > 0) setLinkSearchOpen(true) }}
                    />
                    {linkSearchOpen ? (
                      <div className="link-target-results">
                        {linkSearching ? <div className="link-target-state">Searching…</div> : null}
                        {!linkSearching && linkResults.length === 0 ? <div className="link-target-state">No matches</div> : null}
                        {linkResults.map((result) => (
                          <button type="button" key={`${result.type}-${result.id}`} className="link-target-result" onClick={() => selectLinkTarget(result)}>
                            <span className="link-target-result-type">{result.type}</span>
                            <span className="link-target-result-label">{result.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </div>
              <button className="btn btn-primary btn-sm" disabled={readOnlyForLock || !linkTargetId.trim()} onClick={() => void addLink()}>
                <Icon name="link" size={15} /> Link
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {canUseAi ? (
        <section className="ticket-links ai-panel">
          <div className="attachments-head">
            <span className="etch">AI assistant</span>
            {aiTriage ? <span className={`status-pill status-${triageStatus === 'resolved' ? 'resolved' : triageStatus === 'handoff' ? 'escalated' : triageStatus === 'waiting_for_user' ? 'pending_user' : 'open'}`}>{triageStatus.replace('_', ' ')}</span> : null}
          </div>
          {aiTriage && triageStatus !== 'idle' ? (
            <div className="ai-result ai-triage-overview">
              <div className="ai-triage-overview-head">
                <div>
                  <span className="muted mono">Automatic triage · round {displayTicketValue(aiTriage.round)}</span>
                  <strong>Technician review</strong>
                </div>
                {typeof aiTriage.lastConfidence === 'number' ? <span className="ai-confidence">{Math.round(aiTriage.lastConfidence * 100)}% confidence</span> : null}
              </div>
              {triageQuestion ? <p>{triageQuestion}</p> : null}
              {triageError ? <p className="muted">{triageError}</p> : null}
              <div className="ticket-link-form">
                <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock || aiTriageBusy || triageStatus === 'disabled' || triageStatus === 'resolved'} onClick={() => void runAiTriageAction('retry')}>Retry triage</button>
                <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock || aiTriageBusy || triageStatus === 'disabled' || triageStatus === 'resolved'} onClick={() => void runAiTriageAction('stop')}>Stop AI</button>
              </div>
            </div>
          ) : null}
          {triageTranscript.length > 0 ? (
            <div className="ai-triage-transcript">
              <div className="ai-subsection-heading">
                <strong>Decision trail</strong>
                <span className="muted">{triageTranscript.length} AI decision{triageTranscript.length === 1 ? '' : 's'}</span>
              </div>
              {triageTranscript.slice().reverse().map((entry) => (
                <article className="ai-decision-card" key={entry.id}>
                  <div className="ai-decision-card-head">
                    <span className="ai-decision-action">{entry.action === 'ask_user' ? 'Asked requester' : entry.action === 'resolve' ? 'Proposed resolution' : 'Handed off'}</span>
                    <span className="muted mono">Round {entry.round} · {Math.round(entry.confidence * 100)}%</span>
                  </div>
                  <p className="ai-decision-message">{entry.message}</p>
                  {entry.rationale ? <div className="ai-decision-detail"><span className="ai-detail-label">Why this decision</span><span>{entry.rationale}</span></div> : null}
                  {entry.evidence.length > 0 ? <div className="ai-decision-detail"><span className="ai-detail-label">Evidence used</span><ul>{entry.evidence.map((item, index) => <li key={`${entry.id}-evidence-${index}`}>{item}</li>)}</ul></div> : null}
                  {entry.policyExplanation ? <div className="ai-decision-detail"><span className="ai-detail-label">Policy and safety</span><span>{entry.policyExplanation}</span></div> : null}
                  <span className="muted mono">{formatWhen(entry.createdAt)}</span>
                </article>
              ))}
            </div>
          ) : null}
          <div className="ticket-link-form">
            <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock || aiSummaryBusy} onClick={() => void runAiSummary()}>
              {aiSummaryBusy ? 'Summarising…' : 'Summarise'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock || aiSimilarBusy} onClick={() => void runAiSimilar()}>
              {aiSimilarBusy ? 'Searching…' : 'Similar incidents'}
            </button>
            <button className="btn btn-ghost btn-sm" disabled={readOnlyForLock || aiDraftBusy} onClick={() => void runAiDraft()}>
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
                  <span>{th.kind === 'internal_note' ? 'internal note' : th.kind === 'session_record' ? 'session' : th.kind === 'ai_triage' ? 'AI assistant' : th.kind === 'ai_worker' ? 'AI worker' : 'message'}</span>
                  <span>{formatWhen(th.created_at)}</span>
                </>
              )}
            </div>
            {th.kind !== 'system_event' ? <div className="timeline-body">{th.body}</div> : null}
          </div>
        ))}
      </div>

      <div
        className={`attachments${dragActive ? ' attachments-drag' : ''}`}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive ? (
          <div className="attachments-drop-hint">
            <Icon name="upload" size={20} />
            <span>Drop files to attach</span>
          </div>
        ) : null}
        <div className="attachments-head">
          <span className="etch">Attachments</span>
          <label className={`btn btn-ghost btn-sm${readOnlyForLock ? ' disabled' : ''}`} title={readOnlyForLock ? 'Attachments are disabled in read-only mode' : 'Attach a file'}>
            {uploading ? 'Uploading…' : 'Add file'}
            <input type="file" multiple hidden disabled={readOnlyForLock} onChange={(e) => onUpload(e)} />
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
                  onClick={() => (isImageAttachment(a) ? void openImagePreview(a) : void downloadAttachment(getAccessToken() ?? '', a.id, a.filename))}
                  title={isImageAttachment(a) ? 'Preview' : 'Download'}
                >
                  {isImageAttachment(a) ? (
                    thumbnails[a.id] ? (
                      <span className="attachment-thumb"><img src={thumbnails[a.id]} alt="" loading="lazy" /></span>
                    ) : (
                      <span className="attachment-icon"><Icon name="image" size={14} /></span>
                    )
                  ) : (
                    <span className="attachment-icon"><Icon name="file" size={14} /></span>
                  )}
                  <span className="attachment-name">{a.filename}</span>
                </button>
                <span className="muted mono">{Math.max(1, Math.round(a.size_bytes / 1024))} KB · {a.uploader_name ?? '—'}</span>
                <span className="attachment-row-actions">
                  {isImageAttachment(a) ? <button className="icon-btn" title="Preview" aria-label={`Preview ${a.filename}`} onClick={() => void openImagePreview(a)}><Icon name="eye" size={14} /></button> : null}
                  <button className="icon-btn" title="Download" aria-label={`Download ${a.filename}`} onClick={() => void downloadAttachment(getAccessToken() ?? '', a.id, a.filename)}><Icon name="download" size={14} /></button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      </div>{/* end ticket-detail-scroll */}

      {previewFullscreen && previewImage ? (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
          <button type="button" className="image-lightbox-close" onClick={closeImagePreview} title="Close (Esc)" aria-label="Close"><Icon name="close" size={20} /></button>
          <div className="image-viewer image-viewer-lightbox">
            {viewerStage}
            {viewerToolbar}
          </div>
        </div>
      ) : (
        <Modal open={Boolean(previewImage) || previewLoading} onClose={closeImagePreview} title={previewImage?.filename ?? 'Attachment preview'} width={980}>
          {previewLoading ? (
            <div className="image-viewer-state">Loading image…</div>
          ) : previewImage ? (
            <div className="image-viewer">
              {viewerStage}
              {viewerToolbar}
            </div>
          ) : null}
        </Modal>
      )}

      <div className="composer ticket-composer-fixed">
        {readOnlyForLock ? (
          <div className="ticket-composer-readonly">
            <Icon name="lock" size={16} />
            <div className="ticket-composer-readonly-text">
              <strong>Read-only view</strong>
              <span>{blockingName} is viewing or working on this ticket. Use the lock icon to request release.</span>
            </div>
            {!lockIsMine ? (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleRequestRelease()}
                disabled={releaseBusy || releaseRequests.some((request) => request.status === 'pending' && request.requested_by === auth.user?.id)}
              >
                <Icon name="send" size={14} />
                {releaseRequests.some((request) => request.status === 'pending' && request.requested_by === auth.user?.id) ? 'Release requested' : releaseBusy ? 'Requesting…' : 'Request release'}
              </button>
            ) : null}
          </div>
        ) : null}
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
