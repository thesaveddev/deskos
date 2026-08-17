import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { clearSessionDock, downloadRecording, endSession, getSession, inviteParticipant, joinSession, listMessages, listParticipants, listRecordings, sendMessage, transferSession, uploadRecording, writeSessionDock, type RemoteSession, type SessionEvent, type SessionParticipant, type SessionRecording } from '../lib/sessions.js'
import { appendSessionChat, disposeSessionRuntime, endSessionRuntime, hasSessionRuntime, sendSessionChat, sendSessionControl, sendSessionFiles, sendSessionInput, sendSessionSystem, sendSessionTerminal, subscribeSessionRuntime, type RuntimeConsoleState } from '../lib/sessionRuntime.js'

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

export default function SessionConsolePage() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [events, setEvents] = useState<SessionEvent[]>([])
  const [consoleState, setConsoleState] = useState<ConsoleState>('loading')
  const [error, setError] = useState<string | null>(null)
  const [ending, setEnding] = useState(false)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [remoteCursor, setRemoteCursor] = useState<RemoteCursor | null>(null)
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
  const [chatMessages, setChatMessages] = useState<Array<{ senderType: string; body: string; createdAt: string }>>([])
  const [chatDraft, setChatDraft] = useState('')
  const [participants, setParticipants] = useState<SessionParticipant[]>([])
  const [participantNotice, setParticipantNotice] = useState<string | null>(null)
  const [inviteUserId, setInviteUserId] = useState('')
  const [inviteRole, setInviteRole] = useState<'technician' | 'observer'>('technician')
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
    if (remoteStream && videoRef.current) {
      videoRef.current.srcObject = remoteStream
      void videoRef.current.play().catch(() => {
        setError('The browser received the remote screen but could not start video playback.')
      })
    }
  }, [remoteStream])

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
      setCursorStyle({
        left: `${(bounds.width - renderedWidth) / 2 + remoteCursor.x * renderedWidth}px`,
        top: `${(bounds.height - renderedHeight) / 2 + remoteCursor.y * renderedHeight}px`,
      })
    }
    updateCursorStyle()
    window.addEventListener('resize', updateCursorStyle)
    return () => window.removeEventListener('resize', updateCursorStyle)
  }, [remoteCursor, remoteStream, videoReady])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    let unsubscribe: (() => void) | undefined
    const history = (location.state as HistoryState | null) ?? null

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

        const joinToken = history?.joinToken ?? (hasSessionRuntime(id) ? undefined : (await joinSession(id)).joinToken)
        if (cancelled) return
        unsubscribe = subscribeSessionRuntime(id, joinToken, (snapshot) => {
          if (cancelled) return
          setConsoleState(snapshot.state)
          setError(snapshot.error)
          setRemoteStream(snapshot.remoteStream)
          setRemoteCursor(snapshot.remoteCursor)
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
        })

        if (seededCollabRef.current !== id) {
          seededCollabRef.current = id
          void listMessages(id).then(({ messages }) => {
            if (cancelled) return
            for (const message of messages) {
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
        }
      }).catch(() => undefined)
    }, 5000)
    return () => window.clearInterval(timer)
  }, [id])

  const canControl = session?.permissions.includes('control_input') ?? false
  const canClipboard = session?.permissions.includes('clipboard') ?? false
  const canTerminal = session?.permissions.includes('terminal') && session.permissions.includes('elevation')
  const canFileTransfer = session?.permissions.includes('file_transfer') ?? false
  const canSystemManage = session?.permissions.includes('system_manage') && session.permissions.includes('elevation')

  useEffect(() => {
    if (id && canFileTransfer && fileChannelReady && controlArmed) {
      sendSessionFiles(id, { action: 'list', path: '' }, true)
    }
  }, [id, canFileTransfer, fileChannelReady, controlArmed])

  const sendInput = (payload: Record<string, unknown>) => {
    if (!id || !canControl) return
    sendSessionInput(id, payload, controlArmed)
  }

  const point = (event: MouseEvent<HTMLVideoElement> | PointerEvent<HTMLVideoElement>): { x: number; y: number } => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const sourceWidth = event.currentTarget.videoWidth || bounds.width
    const sourceHeight = event.currentTarget.videoHeight || bounds.height
    const scale = Math.min(bounds.width / sourceWidth, bounds.height / sourceHeight)
    const renderedWidth = sourceWidth * scale
    const renderedHeight = sourceHeight * scale
    const offsetX = (bounds.width - renderedWidth) / 2
    const offsetY = (bounds.height - renderedHeight) / 2
    return {
      x: Math.min(1, Math.max(0, (event.clientX - bounds.left - offsetX) / renderedWidth)),
      y: Math.min(1, Math.max(0, (event.clientY - bounds.top - offsetY) / renderedHeight)),
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

  const terminateProcess = (pid: number) => {
    if (!id || !canSystemManage || !window.confirm(`Terminate process ${pid}?`)) return
    setSysdataStatus(`Terminating process ${pid}…`)
    sendSessionSystem(id, { action: 'process_terminate', pid }, controlArmed)
  }

  const refreshServices = () => {
    if (!id || !canSystemManage) return
    setSysdataStatus('Loading services…')
    sendSessionSystem(id, { action: 'service_list' }, controlArmed)
  }

  const changeService = (action: 'service_start' | 'service_stop', name: string) => {
    if (!id || !canSystemManage || !window.confirm(`${action === 'service_start' ? 'Start' : 'Stop'} ${name}?`)) return
    setSysdataStatus(`${action === 'service_start' ? 'Starting' : 'Stopping'} ${name}…`)
    sendSessionSystem(id, { action, name }, controlArmed)
  }

  const sendChat = async () => {
    if (!id || !chatDraft.trim()) return
    const body = chatDraft.trim()
    setChatDraft('')
    try {
      const { message } = await sendMessage(id, body)
      appendSessionChat(id, { senderType: 'technician', body: message.body, createdAt: message.created_at })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send chat message')
      return
    }
    sendSessionChat(id, body)
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
    if (!id || !window.confirm('Transfer session ownership to this technician?')) return
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
    const transferId = crypto.randomUUID()
    const targetPath = filePath ? `${filePath}/${file.name}` : file.name
    setFileStatus(`Uploading ${file.name}…`)
    sendSessionFiles(id, { action: 'upload_start', transferId, path: targetPath }, controlArmed)
    const bytes = new Uint8Array(await file.arrayBuffer())
    for (let offset = 0; offset < bytes.length; offset += 16 * 1024) {
      sendSessionFiles(id, { action: 'upload_chunk', transferId, data: encodeChunk(bytes.slice(offset, offset + 16 * 1024)) }, controlArmed)
    }
    sendSessionFiles(id, { action: 'upload_complete', transferId }, controlArmed)
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
      <div className="console-breadcrumb"><Link to="/sessions">Sessions</Link><span>/</span><span>{session?.device_name ?? 'Remote session'}</span></div>
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
                void videoRef.current?.play().catch(() => undefined)
              }}
            />
            {remoteCursor?.visible && !remoteCursor.embedded && cursorStyle ? <span className="remote-cursor" style={cursorStyle} aria-hidden="true" /> : null}
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
            <div className="console-state-line"><span className={`status-pill session-state-${session?.state ?? 'requested'}`}>{session?.state ?? 'requested'}</span><span className="mono muted">{stateLabel(consoleState)}</span></div>
            <p className="console-help">The session remains connected while you navigate DeskOS. Return using the session dock; the peer, video stream, and input channels stay owned by the browser session runtime.</p>
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
          {canFileTransfer ? <section className="detail-card">
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
            <div className="chat-log">
              {chatMessages.length === 0 ? <span className="muted">No messages yet.</span> : chatMessages.map((message, index) => (
                <div className={`chat-row chat-${message.senderType}`} key={`${message.createdAt}-${index}`}>
                  <strong>{message.senderType === 'agent' ? 'Endpoint' : message.senderType === 'system' ? 'System' : 'Technician'}</strong>
                  <span>{message.body}</span>
                </div>
              ))}
            </div>
            <textarea className="field-input terminal-input" value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} placeholder="Message the endpoint user" rows={2} />
            <button className="btn btn-primary btn-sm btn-block" onClick={() => void sendChat()} disabled={!chatDraft.trim()}>Send message</button>
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
            <div className="clipboard-actions">
              <input className="field-input" value={inviteUserId} onChange={(event) => setInviteUserId(event.target.value)} placeholder="User ID" />
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
