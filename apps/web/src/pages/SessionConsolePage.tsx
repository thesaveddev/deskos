import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert, useConfirm } from '../components/ui.js'
import { api } from '../lib/api.js'
import { clearSessionDock, downloadRecording, endSession, getSession, inviteParticipant, joinSession, listMessages, listParticipants, listRecordings, readSessionDock, sendMessage, transferSession, uploadRecording, writeSessionDock, type RemoteSession, type SessionEvent, type SessionParticipant, type SessionRecording } from '../lib/sessions.js'
import { appendSessionChat, disposeSessionRuntime, endSessionRuntime, hasSessionRuntime, isSessionRuntimeAlive, reconnectSessionRuntime, sendSessionChat, sendSessionChatWithAttachment, sendSessionControl, sendSessionFiles, sendSessionInput, sendSessionSystem, sendSessionTerminal, sendSessionTyping, subscribeSessionRuntime, type ChatAttachment, type RemoteMonitor, type RuntimeConsoleState, type SessionChatMessage } from '../lib/sessionRuntime.js'

type ConsoleState = 'loading' | RuntimeConsoleState
type HistoryState = { joinToken?: string }
type RemoteCursor = { x: number; y: number; visible: boolean; embedded?: boolean }

function stateLabel(state: ConsoleState): string {
  return {
    loading: 'Loading session',
    authorizing: 'Authorizing broker access',
    connecting: 'Connecting to relay',
    waiting: 'Waiting for endpoint',
    negotiating: 'Negotiating secure media',
    connected: 'Connected',
    ended: 'Session ended',
    error: 'Connection error',
  }[state]
}

function eventLabel(event: SessionEvent): string {
  return event.event.replace(/^session\./, '').replaceAll('_', ' ')
}

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function firstUrl(text: string): string | null {
  const match = text.match(URL_PATTERN)
  return match ? match[0] : null
}

/**
 * Human-friendly monitor name. Windows reports device paths like
 * `\\.\DISPLAY1` or `\\?\DISPLAY2`; macOS reports names like "Color LCD".
 * This strips the path and falls back to "Display N" for anything that is
 * not a readable label.
 */
function monitorLabel(monitor: RemoteMonitor): string {
  const raw = (monitor.name ?? '').trim()
  const cleaned = (raw.split('\\').pop() ?? '').trim()
  const digits = cleaned.match(/^DISPLAY(\d+)$/i)
  if (digits) return `Display ${digits[1]}`
  if (!raw || raw.includes('\\') || raw.includes('/') || cleaned === '' || cleaned.length > 32) {
    return `Display ${monitor.id + 1}`
  }
  return cleaned
}

function linkifyText(text: string): ReactNode[] {
  const parts = text.split(URL_PATTERN)
  return parts.map((part, index) =>
    part.startsWith('http://') || part.startsWith('https://')
      ? <a key={index} href={part} target="_blank" rel="noopener noreferrer" className="chat-link">{part}</a>
      : <span key={index}>{part}</span>,
  )
}

export default function SessionConsolePage() {
  const { id } = useParams<{ id: string }>()
  const confirm = useConfirm()
  const location = useLocation()
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [consoleState, setConsoleState] = useState<ConsoleState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [ending, setEnding] = useState(false)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [remoteCursor, setRemoteCursor] = useState<RemoteCursor | null>(null)
  const [monitors, setMonitors] = useState<RemoteMonitor[]>([])
  const [selectedMonitorId, setSelectedMonitorId] = useState<number | null>(null)
  const [monitorStatus, setMonitorStatus] = useState<string | null>(null)
  const [displayPickerOpen, setDisplayPickerOpen] = useState(false)
  const [displaySelectionMode, setDisplaySelectionMode] = useState<'all' | 'single'>('all')
  const [recoveredAfterReload, setRecoveredAfterReload] = useState(false)
  const [cursorStyle, setCursorStyle] = useState<{ left: string; top: string } | null>(null)
  const [videoReady, setVideoReady] = useState(0)
  const [controlArmed, setControlArmed] = useState(false)
  const [presence, setPresence] = useState<'waiting' | 'endpoint_ready'>('waiting')
  const [remoteClipboard, setRemoteClipboard] = useState('')
  const [clipboardDraft, setClipboardDraft] = useState('')
  const [clipboardStatus, setClipboardStatus] = useState<string | null>(null)
  const [terminalChannelReady, setTerminalChannelReady] = useState(false)
  const [terminalReady, setTerminalReady] = useState(false)
  const [terminalOutput, setTerminalOutput] = useState('')
  const [terminalInput, setTerminalInput] = useState('')
  const [terminalStatus, setTerminalStatus] = useState<string | null>(null)
  const [fileChannelReady, setFileChannelReady] = useState(false)
  const [fileEntries, setFileEntries] = useState<Array<{ name: string; directory: boolean; size: number }>>([])
  const [filePath, setFilePath] = useState('')
  const [fileRoot, setFileRoot] = useState('')
  const [fileStatus, setFileStatus] = useState<string | null>(null)
  const [downloadName, setDownloadName] = useState<string | null>(null)
  const [downloadData, setDownloadData] = useState<string | null>(null)
  const [sysdataChannelReady, setSysdataChannelReady] = useState(false)
  const [processes, setProcesses] = useState<Array<{ pid: number; name: string; cpu: number; memory: number; user?: string }>>([])
  const [services, setServices] = useState<Array<{ name: string }>>([])
  const [sysdataStatus, setSysdataStatus] = useState<string | null>(null)
  const [chatMessages, setChatMessages] = useState<SessionChatMessage[]>([])
  const [chatDraft, setChatDraft] = useState('')
  const [peerTyping, setPeerTyping] = useState<string | null>(null)
  const typingTimeoutRef = useRef<number | undefined>(undefined)
  const [pendingImages, setPendingImages] = useState<Array<{ name: string; dataUrl: string }>>([])
  const [deliveredKeys, setDeliveredKeys] = useState<Set<string>>(new Set())
  const seenChatKeysRef = useRef<Set<string>>(new Set())
  const chatMessagesRef = useRef<SessionChatMessage[]>([])
  const chatLogRef = useRef<HTMLDivElement | null>(null)
  const chatComposerRef = useRef<HTMLTextAreaElement | null>(null)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const [participants, setParticipants] = useState<SessionParticipant[]>([])
  const [participantNotice, setParticipantNotice] = useState<string | null>(null)
  const [inviteUserId, setInviteUserId] = useState('')
  const [inviteRole, setInviteRole] = useState<'technician' | 'observer'>('technician')
  const [inviteSearch, setInviteSearch] = useState('')
  const [inviteResults, setInviteResults] = useState<Array<{ id: string; name: string; email: string }>>([])
  const [inviteSearching, setInviteSearching] = useState(false)
  const [inviteDropdownOpen, setInviteDropdownOpen] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [recordingActive, setRecordingActive] = useState(false)
  const [recordingBusy, setRecordingBusy] = useState(false)
  const [recordingNotice, setRecordingNotice] = useState<string | null>(null)
  const [recordings, setRecordings] = useState<SessionRecording[]>([])
  const stageRef = useRef<HTMLElement | null>(null)
  const videoWrapRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const lastPointerSentRef = useRef(0)
  const seededCollabRef = useRef<string | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordChunksRef = useRef<Blob[]>([])
  const recordStartedAtRef = useRef(0)

  useEffect(() => {
    if (controlArmed) stageRef.current?.focus()
  }, [controlArmed])

  useEffect(() => {
    if (!displayPickerOpen) return
    const close = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.session-display-picker-wrap')) setDisplayPickerOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [displayPickerOpen])

  const attachRemoteVideo = () => {
    const video = videoRef.current
    if (!video || !remoteStream) return
    if (video.srcObject !== remoteStream) video.srcObject = remoteStream
    void video.play().catch((reason: unknown) => {
      // Autoplay policy can reject the first attempt even though the media
      // arrived. Keep the session usable and retry from the user gesture.
      if (reason instanceof DOMException && reason.name === 'NotAllowedError') {
        setError('The remote screen is ready. Click the video area to start playback.')
        return
      }
      setError('The browser received the remote screen but could not start video playback.')
    })
  }

  useEffect(() => {
    attachRemoteVideo()
    // The video element is recreated when the stream arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteStream, videoReady])

  useEffect(() => {
    const updateCursorStyle = () => {
      const wrapper = videoWrapRef.current
      const video = videoRef.current
      if (!wrapper || !video || !remoteCursor) {
        setCursorStyle(null)
        return
      }
      const bounds = wrapper.getBoundingClientRect()
      const sourceWidth = video.videoWidth || bounds.width
      const sourceHeight = video.videoHeight || bounds.height
      const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight)
      const renderedWidth = sourceWidth * scale
      const renderedHeight = sourceHeight * scale
      let cursorX = remoteCursor.x
      let cursorY = remoteCursor.y
      if (selectedMonitor) {
        const virtual = virtualBounds()
        if (!virtual) {
          setCursorStyle(null)
          return
        }
        const absoluteX = virtual.left + remoteCursor.x * virtual.width
        const absoluteY = virtual.top + remoteCursor.y * virtual.height
        cursorX = (absoluteX - selectedMonitor.x) / Math.max(1, selectedMonitor.width)
        cursorY = (absoluteY - selectedMonitor.y) / Math.max(1, selectedMonitor.height)
        if (cursorX < 0 || cursorX > 1 || cursorY < 0 || cursorY > 1) {
          setCursorStyle(null)
          return
        }
      }
      setCursorStyle({
        left: `${(bounds.width - renderedWidth) / 2 + cursorX * renderedWidth}px`,
        top: `${(bounds.height - renderedHeight) / 2 + cursorY * renderedHeight}px`,
      })
    }
    updateCursorStyle()
    window.addEventListener('resize', updateCursorStyle)
    return () => window.removeEventListener('resize', updateCursorStyle)
  }, [remoteCursor, remoteStream, videoReady, monitors, selectedMonitorId])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const history = (location.state as HistoryState | null) ?? null
    const recoveredFromDock = !history?.joinToken && Boolean(readSessionDock()?.id === id)
    setRecoveredAfterReload(recoveredFromDock)

    const loadAndConnect = async () => {
      try {
        setConsoleState('loading')
        const detail = await getSession(id)
        if (cancelled) return
        setSession(detail.session)
        if (['ended', 'denied', 'expired'].includes(detail.session.state)) {
          clearSessionDock(detail.session.id)
          setConsoleState('ended')
          return
        }
        writeSessionDock({ id: detail.session.id, deviceName: detail.session.device_name ?? detail.session.hostname ?? 'Remote session', state: detail.session.state })
        setEvents(detail.events)
        setConsoleState('authorizing')

        // A join ticket is short-lived. On a page reload, request a fresh one
        // from the authenticated API; never persist relay credentials in browser storage.
        const runtimeReusable = hasSessionRuntime(id) && isSessionRuntimeAlive(id)
        const joinToken = history?.joinToken ?? (runtimeReusable ? undefined : (await joinSession(id)).joinToken)
        if (cancelled) return
        writeSessionDock({ id: detail.session.id, deviceName: detail.session.device_name ?? detail.session.hostname ?? 'Remote session', state: detail.session.state })
        unsubscribe = subscribeSessionRuntime(id, joinToken, (snapshot) => {
          if (cancelled) return
          setConsoleState(snapshot.state)
          setError(snapshot.error)
          setRemoteStream(snapshot.remoteStream)
          setRemoteCursor(snapshot.remoteCursor)
          setMonitors(snapshot.monitors)
          setSelectedMonitorId(snapshot.selectedMonitorId)
          setDisplaySelectionMode(snapshot.selectedMonitorId === null ? 'all' : 'single')
          setMonitorStatus(snapshot.monitorStatus)
          setControlArmed(snapshot.controlArmed)
          setPresence(snapshot.presence)
          setRemoteClipboard(snapshot.remoteClipboard ?? '')
          setClipboardStatus(snapshot.clipboardStatus)
          setTerminalChannelReady(snapshot.terminalChannelReady)
          setTerminalReady(snapshot.terminalReady)
          setTerminalOutput(snapshot.terminalOutput)
          setTerminalStatus(snapshot.terminalStatus)
          setFileChannelReady(snapshot.fileChannelReady)
          setFileEntries(snapshot.fileEntries)
          setFilePath(snapshot.filePath)
          setFileRoot(snapshot.fileRoot)
          setFileStatus(snapshot.fileStatus)
          setDownloadName(snapshot.downloadName)
          setDownloadData(snapshot.downloadData)
          setSysdataChannelReady(snapshot.sysdataChannelReady)
          setProcesses(snapshot.processes)
          setServices(snapshot.services)
          setSysdataStatus(snapshot.sysdataStatus)
          setChatMessages(snapshot.chatMessages)
          chatMessagesRef.current = snapshot.chatMessages
          setPeerTyping(snapshot.typingUser)
        })

        if (seededCollabRef.current !== id) {
          seededCollabRef.current = id
          void listMessages(id).then(({ messages }) => {
            if (cancelled) return
            for (const message of messages) {
              seenChatKeysRef.current.add(`${message.sender_type}:${message.body}:${message.created_at}`)
              appendSessionChat(id, { senderType: message.sender_type, body: message.body, createdAt: message.created_at })
            }
          }).catch(() => undefined)
          void listParticipants(id).then(({ participants }) => {
            if (cancelled) return
            setParticipants(participants)
          }).catch(() => undefined)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Could not open the remote session')
        setConsoleState('error')
      }
    }

    void loadAndConnect()
    return () => {
      cancelled = true
      unsubscribe?.()
      setRemoteStream(null)
      setRemoteCursor(null)
      setMonitors([])
      setSelectedMonitorId(null)
      setMonitorStatus(null)
      setCursorStyle(null)
      setVideoReady(0)
      setImmersive(false)
      const recorder = mediaRecorderRef.current
      mediaRecorderRef.current = null
      if (recorder && recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          /* ignore */
        }
      }
      setRecordingActive(false)
    }
  }, [id, location.state])

  useEffect(() => {
    if (id && session?.recording_mode === 'video') {
      void refreshRecordings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session?.recording_mode])

  useEffect(() => {
    if (!id) return
    const timer = window.setInterval(() => {
      void getSession(id).then((detail) => {
        setSession(detail.session)
        setEvents(detail.events)
        if (['ended', 'denied', 'expired'].includes(detail.session.state)) {
          clearSessionDock(detail.session.id)
          disposeSessionRuntime(detail.session.id)
          setConsoleState('ended')
        } else {
          writeSessionDock({ id: detail.session.id, deviceName: detail.session.device_name ?? detail.session.hostname ?? 'Remote session', state: detail.session.state })
          // The runtime socket can silently die (relay restart, tab switch,
          // network blip). Rejoin with a fresh ticket so the console always
          // recovers instead of sitting on a dead connection.
          if (hasSessionRuntime(id) && !isSessionRuntimeAlive(id)) {
            void joinSession(id).then(({ joinToken }) => reconnectSessionRuntime(id, joinToken)).catch(() => undefined)
          }
        }
      }).catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [id])

  // Endpoint replies from the browser companion page land in the API; merge
  // them into the live chat without duplicating relay-delivered messages.
  useEffect(() => {
    if (!id) return
    const mergePolled = (messages: Array<{ sender_type: string; body: string; created_at: string }>) => {
      const recent = chatMessagesRef.current.slice(-25)
      for (const message of messages) {
        const key = `${message.sender_type}:${message.body}:${message.created_at}`
        if (seenChatKeysRef.current.has(key)) continue
        seenChatKeysRef.current.add(key)
        const alreadyShown = recent.some((existing) =>
          existing.senderType === message.sender_type &&
          existing.body === message.body &&
          Math.abs(Date.parse(existing.createdAt) - Date.parse(message.created_at)) < 15_000,
        )
        if (alreadyShown) continue
        appendSessionChat(id, { senderType: message.sender_type, body: message.body, createdAt: message.created_at })
      }
    }
    const timer = window.setInterval(() => {
      void listMessages(id).then(({ messages }) => mergePolled(messages)).catch(() => undefined)
    }, 3000)
    return () => window.clearInterval(timer)
  }, [id])

  useEffect(() => {
    const el = chatLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, peerTyping])

  const canControl = session?.permissions.includes('control_input') ?? false
  const canClipboard = session?.permissions.includes('clipboard') ?? false
  const canTerminal = session?.permissions.includes('terminal') && session.permissions.includes('elevation')
  const canFileTransfer = session?.permissions.includes('file_transfer') ?? false
  const canSystemManage = session?.permissions.includes('system_manage') && session.permissions.includes('elevation')
  const canSelectMonitor = session?.permissions.includes('view_screen') === true && (consoleState === 'connected' || consoleState === 'negotiating')

  useEffect(() => {
    if (id && canFileTransfer && fileChannelReady && controlArmed) {
      sendSessionFiles(id, { action: 'list', path: '' }, true)
    }
  }, [id, canFileTransfer, fileChannelReady, controlArmed])

  const virtualBounds = () => {
    if (monitors.length === 0) return null
    const left = Math.min(...monitors.map((monitor) => monitor.x))
    const top = Math.min(...monitors.map((monitor) => monitor.y))
    const right = Math.max(...monitors.map((monitor) => monitor.x + monitor.width))
    const bottom = Math.max(...monitors.map((monitor) => monitor.y + monitor.height))
    return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
  }

  const selectedMonitor = selectedMonitorId === null ? null : monitors.find((monitor) => monitor.id === selectedMonitorId) ?? null
  // If the selected display no longer exists (unplugged / renegotiated),
  // behave as "all displays" instead of leaving the console on a dead pick.
  const effectiveSelectedId = selectedMonitorId !== null
    ? (monitors.some((monitor) => monitor.id === selectedMonitorId) ? selectedMonitorId : null)
    : null

  // Ask the endpoint for its display list when the console connects, and
  // retry a few times on a slow endpoint so the switcher always appears even
  // if the first handshake is missed.
  useEffect(() => {
    if (!id || consoleState !== 'connected' || !canSelectMonitor) return
    const attempts = 3
    let attempt = 0
    const run = () => {
      attempt += 1
      sendSessionControl(id, { action: 'monitor_list' }, true)
    }
    run()
    const timer = window.setInterval(() => {
      if (attempt >= attempts) {
        window.clearInterval(timer)
        return
      }
      run()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [id, consoleState, canSelectMonitor])

  const detectDisplays = () => {
    if (!id || !canSelectMonitor) return
    setMonitorStatus('Detecting displays…')
    sendSessionControl(id, { action: 'monitor_list' }, true)
  }

  const toVirtualPoint = (x: number, y: number): { x: number; y: number } => {
    if (!selectedMonitor || effectiveSelectedId === null) return { x, y }
    const bounds = virtualBounds()
    if (!bounds) return { x, y }
    return {
      x: (selectedMonitor.x + x * selectedMonitor.width - bounds.left) / bounds.width,
      y: (selectedMonitor.y + y * selectedMonitor.height - bounds.top) / bounds.height,
    }
  }


  const sendInput = (payload: Record<string, unknown>) => {
    if (!id || !canControl) return
    const x = typeof payload.x === 'number' ? payload.x : null
    const y = typeof payload.y === 'number' ? payload.y : null
    const mapped = x !== null && y !== null ? { ...payload, ...toVirtualPoint(x, y) } : payload
    sendSessionInput(id, mapped, controlArmed)
  }

  const selectMonitor = (value: string) => {
    if (!id || !canSelectMonitor) return
    if (value === 'all') {
      setSelectedMonitorId(null)
      setDisplaySelectionMode('all')
      setMonitorStatus('Showing all displays…')
      sendSessionControl(id, { action: 'monitor_all' }, controlArmed)
      return
    }
    const monitorId = Number(value)
    if (!Number.isInteger(monitorId)) return
    setSelectedMonitorId(monitorId)
    setDisplaySelectionMode('single')
    setMonitorStatus('Switching display…')
    sendSessionControl(id, { action: 'monitor_select', monitorId }, controlArmed)
  }

  const point = (event: MouseEvent<HTMLVideoElement> | PointerEvent<HTMLVideoElement>): { x: number; y: number } => {
    const video = event.currentTarget
    const bounds = video.getBoundingClientRect()
    const sourceWidth = video.videoWidth || bounds.width
    const sourceHeight = video.videoHeight || bounds.height
    const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight)
    const renderedWidth = sourceWidth * scale
    const renderedHeight = sourceHeight * scale
    const offsetX = (bounds.width - renderedWidth) / 2
    const offsetY = (bounds.height - renderedHeight) / 2
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left - offsetX) / Math.max(1, renderedWidth))),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top - offsetY) / Math.max(1, renderedHeight))),
    }
  }

  const requestClipboard = () => {
    if (!id || !canClipboard) return
    setClipboardStatus('Requesting endpoint clipboard…')
    sendSessionControl(id, { action: 'clipboard_get', requestId: crypto.randomUUID() }, controlArmed)
  }

  const sendClipboard = () => {
    if (!id || !canClipboard) return
    setClipboardStatus('Sending clipboard to endpoint…')
    sendSessionControl(id, { action: 'clipboard_set', requestId: crypto.randomUUID(), text: clipboardDraft }, controlArmed)
  }

  const copyClipboardLocally = () => {
    void navigator.clipboard.writeText(remoteClipboard).then(() => setClipboardStatus('Copied to technician clipboard.')).catch(() => setClipboardStatus('The browser blocked local clipboard access.'))
  }

  const startTerminal = () => {
    if (!id || !canTerminal) return
    setTerminalStatus('Starting elevated terminal…')
    sendSessionTerminal(id, { action: 'start' }, controlArmed)
  }

  const sendTerminalInput = () => {
    if (!id || !canTerminal || !terminalInput) return
    sendSessionTerminal(id, { action: 'input', text: terminalInput }, controlArmed)
    setTerminalInput('')
  }

  const closeTerminal = () => {
    if (!id || !canTerminal) return
    sendSessionTerminal(id, { action: 'close' }, controlArmed)
  }

  const refreshProcesses = () => {
    if (!id || !canSystemManage) return
    setSysdataStatus('Loading processes…')
    sendSessionSystem(id, { action: 'process_list' }, controlArmed)
  }

  const terminateProcess = async (pid: number) => {
    if (!id || !canSystemManage || !await confirm(`Terminate process ${pid}?`, { title: 'Terminate process', confirmLabel: 'Terminate', destructive: true })) return
    setSysdataStatus(`Terminating process ${pid}…`)
    sendSessionSystem(id, { action: 'process_terminate', pid }, controlArmed)
  }

  const refreshServices = () => {
    if (!id || !canSystemManage) return
    setSysdataStatus('Loading services…')
    sendSessionSystem(id, { action: 'service_list' }, controlArmed)
  }

  const changeService = async (action: 'service_start' | 'service_stop', name: string) => {
    if (!id || !canSystemManage || !await confirm(`${action === 'service_start' ? 'Start' : 'Stop'} ${name}?`, { title: `${action === 'service_start' ? 'Start' : 'Stop'} service`, confirmLabel: action === 'service_start' ? 'Start service' : 'Stop service', destructive: action === 'service_stop' })) return
    setSysdataStatus(`${action === 'service_start' ? 'Starting' : 'Stopping'} ${name}…`)
    sendSessionSystem(id, { action, name }, controlArmed)
  }

  const searchMembers = async (query: string) => {
    if (query.length < 2) { setInviteResults([]); return }
    setInviteSearching(true)
    try {
      const params = new URLSearchParams({ search: query })
      const result = await api<{ members: Array<{ membership_id: string; org_role: string; status: string; user_id: string; name: string; email: string }> }>(`/members?${params}`)
      setInviteResults(result.members.filter((m) => m.status === 'active').map((m) => ({ id: m.user_id, name: m.name, email: m.email })))
    } catch { setInviteResults([]) }
    finally { setInviteSearching(false) }
  }

  const sendChat = async () => {
    if (!id) return
    const body = chatDraft.trim()
    const images = pendingImages
    if (!body && images.length === 0) return
    setChatDraft('')
    setPendingImages([])
    const deliver = (payload: { body: string; attachment?: ChatAttachment }) => {
      const createdAt = new Date().toISOString()
      appendSessionChat(id, { senderType: 'technician', body: payload.body, createdAt, attachment: payload.attachment })
      if (isSessionRuntimeAlive(id)) {
        if (payload.attachment) sendSessionChatWithAttachment(id, payload.body, payload.attachment)
        else sendSessionChat(id, payload.body)
        setDeliveredKeys((current) => new Set(current).add(createdAt))
      }
      sendMessage(id, payload.body).catch(() => {
        /* API persistence is best-effort; the relay already delivered */
      })
    }
    if (images.length === 0) {
      deliver({ body })
      return
    }
    for (let i = 0; i < images.length; i += 1) {
      deliver({ body: i === 0 ? body : '', attachment: { kind: 'image', name: images[i].name, dataUrl: images[i].dataUrl } })
    }
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) return
    event.preventDefault()
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setPendingImages((current) => [...current, { name: file.name, dataUrl: reader.result as string }])
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const handleImageFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('image/'))
    event.target.value = ''
    for (const file of files.slice(0, 4)) {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          setPendingImages((current) => [...current, { name: file.name, dataUrl: reader.result as string }])
        }
      }
      reader.readAsDataURL(file)
    }
  }

  const scrollToFiles = () => {
    document.getElementById('session-files-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const reconnectNow = async () => {
    if (!id) return
    setError(null)
    try {
      const { joinToken } = await joinSession(id)
      reconnectSessionRuntime(id, joinToken)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reconnect to the session.')
    }
  }

  const invite = async () => {
    if (!id || !inviteUserId.trim()) return
    setParticipantNotice(null)
    try {
      await inviteParticipant(id, inviteUserId.trim(), inviteRole)
      setInviteUserId('')
      const { participants } = await listParticipants(id)
      setParticipants(participants)
      setParticipantNotice('Invitation sent.')
    } catch (err) {
      setParticipantNotice(err instanceof Error ? err.message : 'Could not invite participant')
    }
  }

  const transfer = async (userId: string) => {
    if (!id || !await confirm('Transfer session ownership to this technician?', { title: 'Transfer session ownership', confirmLabel: 'Transfer session' })) return
    setParticipantNotice(null)
    try {
      await transferSession(id, userId)
      const { participants } = await listParticipants(id)
      setParticipants(participants)
      setParticipantNotice('Ownership transferred.')
    } catch (err) {
      setParticipantNotice(err instanceof Error ? err.message : 'Could not transfer ownership')
    }
  }

  const listFiles = (path: string) => {
    if (!id || !canFileTransfer) return
    setFileStatus('Loading directory…')
    sendSessionFiles(id, { action: 'list', path }, controlArmed)
  }

  const downloadFile = (path: string) => {
    if (!id || !canFileTransfer) return
    setFileStatus('Requesting file…')
    setDownloadData(null)
    sendSessionFiles(id, { action: 'download', path }, controlArmed)
  }

  const encodeChunk = (bytes: Uint8Array): string => {
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  const uploadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file || !id || !canFileTransfer) return
    if (file.size > 16 * 1024 * 1024) {
      setFileStatus('This file exceeds the 16 MB transfer limit.')
      event.target.value = ''
      return
    }
    const transferId = crypto.randomUUID()
    const targetPath = filePath ? `${filePath}/${file.name}` : file.name
    setFileStatus(`Uploading ${file.name}…`)
    sendSessionFiles(id, { action: 'upload_start', transferId, path: targetPath }, controlArmed)
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      sendSessionFiles(id, { action: 'upload_chunk', transferId, data: encodeChunk(bytes.slice(offset, offset + 16 * 1024)) }, controlArmed)
    }
    sendSessionFiles(id, { action: 'upload_complete', transferId }, controlArmed)
    setFileStatus(`${file.name} sent successfully.`)
    event.target.value = ''
  }

  const toggleImmersive = () => setImmersive((active) => !active)
  const buttonName = (button: number): 'left' | 'middle' | 'right' => button === 2 ? 'right' : button === 1 ? 'middle' : 'left'

  const sendPointerMove = (event: PointerEvent<HTMLVideoElement>) => {
    const now = performance.now()
    if (now - lastPointerSentRef.current < 20) return
    lastPointerSentRef.current = now
    sendInput({ action: 'pointermove', ...point(event) })
  }

  const stop = async () => {
    if (!id || ending) return
    setEnding(true)
    try {
      await endSession(id)
      endSessionRuntime(id)
      clearSessionDock(id)
      setConsoleState('ended')
      setSession((current) => current ? { ...current, state: 'ended', ended_at: new Date().toISOString() } : current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not end session')
    } finally {
      setEnding(false)
    }
  }

  const refreshRecordings = async () => {
    if (!id) return
    try {
      setRecordings((await listRecordings(id)).recordings)
    } catch {
      setRecordings([])
    }
  }

  const startRecording = () => {
    if (!id || !remoteStream || recordingActive || !window.MediaRecorder) return
    setRecordingNotice(null)
    try {
      const recorder = new MediaRecorder(remoteStream, { mimeType: 'video/webm' })
      recordChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) recordChunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: 'video/webm' })
        const durationSec = (Date.now() - recordStartedAtRef.current) / 1000
        recordChunksRef.current = []
        if (blob.size === 0) return
        setRecordingBusy(true)
        void uploadRecording(id, blob, durationSec)
          .then(() => {
            setRecordingNotice('Recording saved.')
            void refreshRecordings()
          })
          .catch((err: unknown) => setRecordingNotice(err instanceof Error ? err.message : 'Recording upload failed.'))
          .finally(() => setRecordingBusy(false))
      }
      mediaRecorderRef.current = recorder
      recordStartedAtRef.current = Date.now()
      recorder.start(1000)
      setRecordingActive(true)
    } catch {
      setRecordingNotice('This browser cannot record the session video.')
    }
  }

  const stopRecording = () => {
    const recorder = mediaRecorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setRecordingActive(false)
    mediaRecorderRef.current = null
    try {
      recorder.stop()
    } catch {
      setRecordingNotice('Recording stopped with an error.')
    }
  }

  if (!session && consoleState === 'loading') {
    return <Shell><span className="etch">Loading session console…</span></Shell>
  }

  return (
    <Shell>
      <div className="console-breadcrumb"><Link to="/sessions">Sessions</Link><span>/</span><span>{session?.device_name ?? 'Remote session'}</span></div>        {recoveredAfterReload ? <Alert kind="info">This console was reopened from your active-session dock. ReyDesk fetched a fresh secure connection ticket and is restoring the session.</Alert> : null}

      <div className="console-head">

        <div>
          <div className="console-kicker"><span className={`session-console-dot console-dot-${consoleState}`} />{stateLabel(consoleState)}<span className="mono muted">{session?.type ?? 'session'}</span></div>
          <h1 className="page-title">{session?.device_name ?? 'Remote session'}</h1>
          <p className="page-subtitle">{session?.hostname ?? 'Endpoint'} · {session?.reason || 'No reason recorded'}</p>
        </div>
        <div className="console-actions">
          <button className="btn btn-ghost btn-sm" onClick={toggleImmersive}>{immersive ? 'Exit full screen' : 'Full screen'}</button>
          <Link to="/sessions" className="btn btn-ghost btn-sm">All sessions</Link>
          {session && !['ended', 'denied', 'expired'].includes(session.state) ? <button className="btn btn-danger btn-sm" onClick={() => void stop()} disabled={ending}>{ending ? 'Ending…' : 'End session'}</button> : null}
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="session-console-grid">
        <section
          ref={stageRef}
          className={`session-stage${canControl ? ' session-stage-control' : ''}${immersive ? ' session-stage-immersive' : ''}`}
          aria-label="Remote screen"
          tabIndex={canControl ? 0 : -1}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && immersive) {
              event.preventDefault()
              setImmersive(false)
              return
            }
            if (controlArmed) {
              event.preventDefault()
              sendInput({ action: 'keydown', key: event.key })
            }
          }}
          onKeyUp={(event) => {
            if (controlArmed) {
              event.preventDefault()
              sendInput({ action: 'keyup', key: event.key })
            }
          }}
        >
          {canSelectMonitor ? <div className="session-display-toolbar"><div className="session-screen-picker">
            <button
              type="button"
              className={`session-screen-trigger${displayPickerOpen ? ' is-open' : ''}`}
              onClick={() => setDisplayPickerOpen((open) => !open)}
              aria-expanded={displayPickerOpen}
              aria-haspopup="menu"
              title="Choose which remote display to view"
            >
              <span className="session-screen-trigger-icon" aria-hidden="true">▦</span>
              <span className="session-screen-trigger-label">
                {(() => {
                  const currentDisplay = monitors.find((monitor) => monitor.id === effectiveSelectedId) ?? monitors[0]
                  return displaySelectionMode === 'all' ? 'All displays' : (currentDisplay ? monitorLabel(currentDisplay) : 'Display')
                })()}
              </span>
              <span className="session-screen-trigger-chevron" aria-hidden="true">⌄</span>
            </button>
            {displayPickerOpen ? <div className="session-screen-menu" role="menu">
              <div className="session-screen-menu-head"><strong>Remote displays</strong><span>{monitors.length} available</span></div>
              <button
                type="button"
                className={`session-screen-option${displaySelectionMode === 'all' ? ' active' : ''}`}
                onClick={() => { selectMonitor('all'); setDisplayPickerOpen(false) }}
                role="menuitemradio"
                aria-checked={displaySelectionMode === 'all'}
              >
                <span className="session-screen-tile session-screen-tile-all" aria-hidden="true"><i /><i /></span>
                <span className="session-screen-option-main"><strong>All displays</strong><small>Show the full desktop</small></span>
                {displaySelectionMode === 'all' ? <span className="session-screen-check">✓</span> : null}
              </button>
              {monitors.map((monitor) => {
                const current = effectiveSelectedId === monitor.id
                return (
                  <button
                    type="button"
                    className={`session-screen-option${current ? ' active' : ''}`}
                    onClick={() => { selectMonitor(String(monitor.id)); setDisplayPickerOpen(false) }}
                    key={monitor.id}
                    role="menuitemradio"
                    aria-checked={current}
                  >
                    <span className="session-screen-tile" style={{ aspectRatio: `${Number(monitor.width) || 16} / ${Number(monitor.height) || 9}` }} aria-hidden="true">
                      <span className="session-screen-tile-num">{monitor.id + 1}</span>
                      {monitor.primary ? <span className="session-screen-tile-primary" title="Primary display" /> : null}
                    </span>
                    <span className="session-screen-option-main">
                      <strong>{monitorLabel(monitor)}{monitor.primary ? ' · Primary' : ''}</strong>
                      <small>{monitor.width} × {monitor.height}</small>
                    </span>
                    {current ? <span className="session-screen-check">✓</span> : null}
                  </button>
                )
              })}
              <button type="button" className="session-screen-refresh" onClick={detectDisplays}><span aria-hidden="true">↻</span> Refresh displays</button>
            </div> : null}
            {monitorStatus ? <span className="session-display-status" role="status">{monitorStatus}</span> : null}
          </div></div> : null}
          {remoteStream ? <div ref={videoWrapRef} className="session-video-wrap">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              tabIndex={canControl ? 0 : -1}
              onPointerMove={(event) => {
                if (controlArmed) sendPointerMove(event)
              }}
              onPointerDown={(event) => {
                if (!controlArmed) return
                event.currentTarget.setPointerCapture(event.pointerId)
                sendInput({ action: 'pointerdown', button: buttonName(event.button), ...point(event) })
              }}
              onPointerUp={(event) => {
                if (!controlArmed) return
                sendInput({ action: 'pointerup', button: buttonName(event.button), ...point(event) })
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onPointerCancel={(event) => {
                if (controlArmed) sendInput({ action: 'pointerup', button: buttonName(event.button), ...point(event) })
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
              }}
              onWheel={(event) => {
                if (controlArmed) {
                  event.preventDefault()
                  sendInput({ action: 'wheel', deltaY: event.deltaY, ...point(event) })
                }
              }}
              onContextMenu={(event) => {
                if (controlArmed) event.preventDefault()
              }}
              onLoadedMetadata={() => {
                setVideoReady((ready) => ready + 1)
                attachRemoteVideo()
              }}
              onCanPlay={() => attachRemoteVideo()}
              onClick={() => attachRemoteVideo()}
            />
          </div> : (
            <div className="session-stage-empty">
              <span className="session-stage-icon">◈</span>
              <strong>{consoleState === 'error' ? 'Connection unavailable' : 'Waiting for the endpoint'}</strong>
              <span className="muted">The agent must be online and consent to screen sharing before video appears.</span>
            </div>
          )}
          {immersive ? <button className="session-stage-close btn btn-ghost btn-sm" onClick={toggleImmersive}>Exit full screen</button> : null}
          <div className="session-stage-footer"><span className="mono">VIEW_SCREEN{canControl ? ' · CONTROL_INPUT' : ''}</span><span className="muted">Persistent WebRTC session · end-to-end encrypted</span></div>
        </section>

        <aside className="session-console-side">
          <section className="detail-card">
            <div className="detail-card-head"><h2>Session state</h2><span className="mono muted">live</span></div>
            {canControl ? <button className={`btn btn-sm btn-block ${controlArmed ? 'btn-danger' : 'btn-primary'}`} onClick={() => setControlArmed((armed) => !armed)}>{controlArmed ? 'Disable input control' : 'Enable input control'}</button> : null}
            {monitors.length > 0 ? <p className="console-help">{selectedMonitor ? `${monitorLabel(selectedMonitor)} is selected for control.` : 'All available displays are shown. Use the display controls above the screen to switch.'}</p> : null}
            <div className="console-state-line"><span className={`status-pill session-state-${session?.state ?? 'requested'}`}>{session?.state ?? 'requested'}</span><span className="mono muted">{stateLabel(consoleState)}</span></div>
            {consoleState === 'error' ? <button className="btn btn-primary btn-sm btn-block" onClick={() => void reconnectNow()}>Reconnect</button> : null}
            <p className="console-help">The session remains connected while you navigate ReyDesk. Return using the session dock; the peer, video stream, and input channels stay owned by the browser session runtime.</p>
          </section>
          {session?.recording_mode === 'video' ? <section className="detail-card">
            <div className="detail-card-head"><h2>Recording</h2><span className="mono muted">{recordingActive ? 'capturing' : 'video · consented'}</span></div>
            {recordingActive ? (
              <button className="btn btn-danger btn-sm btn-block" onClick={stopRecording} disabled={!remoteStream}>Stop recording</button>
            ) : (
              <button className="btn btn-primary btn-sm btn-block" onClick={startRecording} disabled={!remoteStream || recordingBusy}>{recordingBusy ? 'Saving…' : 'Start recording'}</button>
            )}
            {recordingNotice ? <span className="muted clipboard-status">{recordingNotice}</span> : null}
            {recordings.length > 0 ? (
              <div className="system-list">
                {recordings.map((recording) => (
                  <div className="system-row" key={recording.id}>
                    <strong>{new Date(recording.created_at).toLocaleString()}</strong>
                    <span className="mono muted">{Math.round(recording.size_bytes / 1024 / 1024)} MB · {recording.duration_sec}s</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => { if (id) void downloadRecording(id, recording.id).catch((err: unknown) => setRecordingNotice(err instanceof Error ? err.message : 'Download failed.')) }}>Download</button>
                  </div>
                ))}
              </div>
            ) : null}
          </section> : null}
          {canSystemManage ? <section className="detail-card">
            <div className="detail-card-head"><h2>Processes & services</h2><span className="mono muted">{sysdataChannelReady ? 'elevated' : 'connecting'}</span></div>
            <div className="clipboard-actions"><button className="btn btn-ghost btn-sm" onClick={refreshProcesses} disabled={!sysdataChannelReady || !controlArmed}>Processes</button><button className="btn btn-ghost btn-sm" onClick={refreshServices} disabled={!sysdataChannelReady || !controlArmed}>Services</button></div>
            {processes.length ? <div className="system-list"><strong className="muted">Processes</strong>{processes.slice(0, 20).map((process) => <div className="system-row" key={process.pid}><span className="mono">{process.pid}</span><strong>{process.name}</strong><span className="muted">{process.memory} KB</span><button className="btn btn-danger btn-sm" onClick={() => terminateProcess(process.pid)}>Terminate</button></div>)}</div> : null}
            {services.length ? <div className="system-list"><strong className="muted">Services</strong>{services.slice(0, 30).map((service) => <div className="system-row" key={service.name}><strong>{service.name}</strong><button className="btn btn-ghost btn-sm" onClick={() => changeService('service_start', service.name)}>Start</button><button className="btn btn-ghost btn-sm" onClick={() => changeService('service_stop', service.name)}>Stop</button></div>)}</div> : null}
            {sysdataStatus ? <span className="muted clipboard-status">{sysdataStatus}</span> : null}
          </section> : null}
          {canFileTransfer ? <section className="detail-card" id="session-files-panel">
            <div className="detail-card-head"><h2>Files</h2><span className="mono muted">{fileChannelReady ? 'managed root' : 'connecting'}</span></div>
            <div className="file-browser-path mono">{fileRoot ? `${fileRoot}/${filePath}` : `/${filePath || ''}`}</div>
            {fileRoot ? <p className="console-help">Transfers are confined to the endpoint&apos;s managed root. Uploads land in the current folder.</p> : null}
            <div className="file-browser-list">
              {filePath ? <button className="file-browser-row" onClick={() => listFiles(filePath.split('/').slice(0, -1).join('/'))}><span>↩</span><strong>Parent directory</strong></button> : null}
              {fileEntries.map((entry) => {
                const nextPath = filePath ? `${filePath}/${entry.name}` : entry.name
                return <div className="file-browser-row" key={nextPath}><span>{entry.directory ? '▣' : '□'}</span><strong>{entry.name}</strong><span className="mono muted">{entry.directory ? 'directory' : `${entry.size} bytes`}</span>{entry.directory ? <button className="btn btn-ghost btn-sm" onClick={() => listFiles(nextPath)}>Open</button> : <button className="btn btn-ghost btn-sm" onClick={() => downloadFile(nextPath)}>Download</button>}</div>
              })}
            </div>
            <label className="btn btn-ghost btn-sm file-upload-label">Upload file<input type="file" onChange={(event) => void uploadFile(event)} disabled={!fileChannelReady || !controlArmed} /></label>
            {downloadData !== null && downloadName ? <a className="btn btn-primary btn-sm btn-block" href={`data:application/octet-stream;base64,${downloadData}`} download={downloadName}>Save {downloadName}</a> : null}
            {fileStatus ? <span className="muted clipboard-status">{fileStatus}</span> : null}
          </section> : null}
          {canTerminal ? <section className="detail-card">
            <div className="detail-card-head"><h2>Terminal</h2><span className="mono muted">elevated · audited</span></div>
            {!terminalReady ? <button className="btn btn-primary btn-sm btn-block" onClick={startTerminal} disabled={!controlArmed || !terminalChannelReady}>Start terminal</button> : null}
            {terminalReady ? <>
              <pre className="terminal-output">{terminalOutput || 'Terminal connected. Type a command below.'}</pre>
              <textarea className="field-input terminal-input" value={terminalInput} onChange={(event) => setTerminalInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendTerminalInput() } }} placeholder="PowerShell command" rows={3} />
              <div className="clipboard-actions"><button className="btn btn-primary btn-sm" onClick={sendTerminalInput} disabled={!terminalInput}>Send</button><button className="btn btn-ghost btn-sm" onClick={closeTerminal}>Close terminal</button></div>
            </> : null}
            {terminalStatus ? <span className="muted clipboard-status">{terminalStatus}</span> : null}
          </section> : null}
          {canClipboard ? <section className="detail-card">
            <div className="detail-card-head"><h2>Clipboard</h2><span className="mono muted">{presence === 'endpoint_ready' ? 'endpoint ready' : 'waiting'}</span></div>
            <button className="btn btn-ghost btn-sm btn-block" onClick={requestClipboard} disabled={!controlArmed}>Read endpoint clipboard</button>
            <textarea className="field-input clipboard-field" value={clipboardDraft} onChange={(event) => setClipboardDraft(event.target.value)} placeholder="Text to send to the endpoint" rows={4} />
            <div className="clipboard-actions">
              <button className="btn btn-primary btn-sm" onClick={sendClipboard} disabled={!controlArmed}>Send to endpoint</button>
              <button className="btn btn-ghost btn-sm" onClick={copyClipboardLocally} disabled={!remoteClipboard}>Copy locally</button>
            </div>
            {remoteClipboard ? <pre className="clipboard-preview">{remoteClipboard}</pre> : null}
            {clipboardStatus ? <span className="muted clipboard-status">{clipboardStatus}</span> : null}
          </section> : null}
          <section className="detail-card">
            <div className="detail-card-head"><h2>Session chat</h2><span className="mono muted">broker-relayed · audited</span></div>
            <div className="chat-log" ref={chatLogRef}>
              {chatMessages.length === 0 ? <span className="muted">No messages yet.</span> : chatMessages.map((message, index) => {
                const key = `${message.createdAt}-${index}`
                const url = firstUrl(message.body)
                const delivered = deliveredKeys.has(message.createdAt)
                const isMine = message.senderType === 'technician'
                return (
                  <div className={`chat-row chat-${message.senderType}`} key={key}>
                    <div className="chat-row-meta"><strong>{message.senderType === 'agent' ? 'Endpoint' : message.senderType === 'system' ? 'System' : 'Technician'}</strong>{isMine ? <span className={`chat-delivery ${delivered ? 'chat-delivery-ok' : ''}`} title={delivered ? 'Delivered via relay' : 'Sent'}>{delivered ? '✓✓' : '✓'}</span> : null}</div>
                    {message.attachment?.kind === 'image' && message.attachment.dataUrl ? <img className="chat-attachment-image" src={message.attachment.dataUrl} alt={message.attachment.name ?? 'Shared image'} /> : null}
                    {message.body ? <p className="chat-body">{linkifyText(message.body)}</p> : null}
                    {url ? <a className="chat-url-preview" href={url} target="_blank" rel="noopener noreferrer">
                      <img className="chat-url-favicon" src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(url))}&sz=64`} alt="" />
                      <span className="chat-url-text"><strong>{hostOf(url)}</strong><small>{url}</small></span>
                      <span className="chat-url-arrow">↗</span>
                    </a> : null}
                  </div>
                )
              })}
              {peerTyping ? <div className="chat-typing"><span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="muted">Endpoint is typing…</span></div> : null}
            </div>
            {pendingImages.length > 0 ? <div className="chat-pending-images">{pendingImages.map((image, index) => (
              <div className="chat-pending-image" key={`${image.name}-${index}`}>
                <img src={image.dataUrl} alt={image.name} />
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setPendingImages((current) => current.filter((_, i) => i !== index))}>Remove</button>
              </div>
            ))}</div> : null}
            <div className="chat-composer-row">
              <button type="button" className="chat-tool-btn" title="Open file transfer panel" onClick={scrollToFiles}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
              </button>
              <textarea ref={chatComposerRef} className="field-input terminal-input chat-composer-input" value={chatDraft} onChange={(event) => {
                setChatDraft(event.target.value)
                if (id && event.target.value.trim()) {
                  sendSessionTyping(id, true)
                  window.clearTimeout(typingTimeoutRef.current)
                  typingTimeoutRef.current = window.setTimeout(() => { if (id) sendSessionTyping(id, false) }, 2_000)
                }
              }} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} onPaste={handlePaste} placeholder="Message the endpoint user" rows={2} />
              <button className="btn btn-primary btn-sm chat-send-btn" onClick={() => void sendChat()} disabled={!chatDraft.trim() && pendingImages.length === 0}>Send</button>
            </div>
            <input ref={imageInputRef} type="file" accept="image/*" multiple hidden onChange={handleImageFiles} />
            <div className="chat-composer-hint"><span className="muted">Enter to send · Shift+Enter for a new line · use Files to transfer documents</span></div>
          </section>
          <section className="detail-card">
            <div className="detail-card-head"><h2>Participants</h2><span className="mono muted">{participants.length} in session</span></div>
            <div className="system-list">
              {participants.map((participant) => (
                <div className="system-row" key={participant.id}>
                  <span className={`status-pill ${participant.role === 'owner' ? 'status-active' : 'status-idle'}`}>{participant.role}</span>
                  <strong>{participant.name}</strong>
                  <span className="mono muted">{participant.email}</span>
                  {participant.role !== 'owner' ? <button className="btn btn-ghost btn-sm" onClick={() => void transfer(participant.user_id)}>Make owner</button> : null}
                </div>
              ))}
            </div>
            <div className="session-invite-wrap">
              <div className="session-invite-picker">
                <input className="field-input" value={inviteSearch} onChange={(event) => { const q = event.target.value; setInviteSearch(q); setInviteUserId(''); setInviteDropdownOpen(true); void searchMembers(q) }} onFocus={() => { if (inviteSearch.length >= 2) setInviteDropdownOpen(true) }} onBlur={() => setTimeout(() => setInviteDropdownOpen(false), 150)} placeholder="Search by name or email" />
                {inviteDropdownOpen && inviteSearch.length >= 2 ? (
                  <div className="session-invite-results">
                    {inviteSearching ? <div className="session-invite-empty">Searching…</div> : inviteResults.length === 0 ? <div className="session-invite-empty">No users found</div> : inviteResults.map((u) => (
                      <button key={u.id} type="button" className="session-invite-option" onMouseDown={(e) => { e.preventDefault(); setInviteUserId(u.id); setInviteSearch(`${u.name} (${u.email})`); setInviteDropdownOpen(false) }}>
                        <strong>{u.name}</strong><small>{u.email}</small>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
              <select className="field-input" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'technician' | 'observer')}>
                <option value="technician">Technician</option>
                <option value="observer">Observer</option>
              </select>
            </div>
            <button className="btn btn-ghost btn-sm btn-block" onClick={() => void invite()} disabled={!inviteUserId.trim()}>Invite</button>
            {participantNotice ? <span className="muted clipboard-status">{participantNotice}</span> : null}
          </section>
          <section className="detail-card">
            <div className="detail-card-head"><h2>Timeline</h2><span className="mono muted">{events.length} events</span></div>
            <div className="console-events">
              {events.length === 0 ? <span className="muted">No session events yet.</span> : events.slice(-8).map((event) => {
                const reason = typeof event.payload?.reason === 'string' ? event.payload.reason : null
                return <div className="console-event" key={event.id}><span>{eventLabel(event)}{reason ? <small className="console-event-reason">{reason}</small> : null}</span><time className="mono muted">{new Date(event.created_at).toLocaleTimeString()}</time></div>
              })}
            </div>
          </section>
        </aside>
      </div>
    </Shell>
  )
}
