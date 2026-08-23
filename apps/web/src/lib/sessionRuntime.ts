import { api } from './api.js'

export type RemoteCursor = { x: number; y: number; visible: boolean; embedded?: boolean }

export type RemoteMonitor = {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  primary: boolean
}

export type RuntimeConsoleState = 'authorizing' | 'connecting' | 'waiting' | 'negotiating' | 'connected' | 'error' | 'ended'

export interface ChatAttachment {
  kind: 'image' | 'file'
  name?: string
  dataUrl?: string
}

export interface SessionChatMessage {
  senderType: string
  body: string
  createdAt: string
  attachment?: ChatAttachment
}

export interface SessionRuntimeSnapshot {
  state: RuntimeConsoleState
  error: string | null
  remoteStream: MediaStream | null
  remoteCursor: RemoteCursor | null
  monitors: RemoteMonitor[]
  selectedMonitorId: number | null
  monitorStatus: string | null
  controlArmed: boolean
  presence: 'waiting' | 'endpoint_ready'
  remoteClipboard: string | null
  clipboardStatus: string | null
  chatMessages: SessionChatMessage[]
  typingUser: string | null
  terminalChannelReady: boolean
  terminalReady: boolean
  terminalOutput: string
  terminalStatus: string | null
  fileChannelReady: boolean
  fileEntries: Array<{ name: string; directory: boolean; size: number }>
  filePath: string
  fileRoot: string
  fileStatus: string | null
  downloadName: string | null
  downloadData: string | null
  sysdataChannelReady: boolean
  processes: Array<{ pid: number; name: string; cpu: number; memory: number; user?: string }>
  services: Array<{ name: string }>
  sysdataStatus: string | null
}

type RuntimeListener = (snapshot: SessionRuntimeSnapshot) => void

type Runtime = {
  id: string
  socket: WebSocket | null
  peer: RTCPeerConnection | null
  iceServers: RTCIceServer[] | null
  controlChannel: RTCDataChannel | null
  inputChannel: RTCDataChannel | null
  terminalChannel: RTCDataChannel | null
  fileChannel: RTCDataChannel | null
  sysdataChannel: RTCDataChannel | null
  pendingIce: RTCIceCandidateInit[]
  listeners: Set<RuntimeListener>
  snapshot: SessionRuntimeSnapshot
}

const runtimes = new Map<string, Runtime>()

function relayUrl(): string {
  const configured = (import.meta as ImportMeta & { env?: { VITE_RELAY_URL?: string } }).env?.VITE_RELAY_URL
  if (configured) return configured
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  // In production nginx proxies /ws to the relay on port 4100.
  // Connect to the same origin so the proxy handles the upgrade — do not
  // hardcode port 4100 which is firewalled externally.
  return `${protocol}://${window.location.host}/ws`
}

function notify(runtime: Runtime, patch: Partial<SessionRuntimeSnapshot>): void {
  runtime.snapshot = { ...runtime.snapshot, ...patch }
  for (const listener of runtime.listeners) listener(runtime.snapshot)
}

function send(runtime: Runtime, message: Record<string, unknown>): void {
  if (runtime.socket?.readyState === WebSocket.OPEN) runtime.socket.send(JSON.stringify(message))
}

function handleControlMessage(runtime: Runtime, event: MessageEvent): void {
  if (typeof event.data !== 'string') return
  if (event.data.includes('control channel ready')) {
    notify(runtime, { state: 'connected', controlArmed: true })
    return
  }
  try {
    const message = JSON.parse(event.data) as Partial<RemoteCursor> & { type?: string; action?: string; status?: string; text?: string; reason?: string; path?: string; root?: string; name?: string; entries?: unknown; data?: string; processes?: unknown; services?: unknown; monitors?: unknown; monitorId?: unknown; selectedMonitorId?: unknown }
    if (message.type === 'presence' && message.status === 'endpoint_ready') {
      notify(runtime, { presence: 'endpoint_ready' })
      return
    }
    if (message.type === 'monitor' && (message.action === 'list' || message.action === 'selected')) {
      const monitors = Array.isArray(message.monitors) ? message.monitors as RemoteMonitor[] : runtime.snapshot.monitors
      const selectedMonitorId = message.monitorId === null || message.monitorId === undefined
        ? (typeof message.selectedMonitorId === 'number' ? message.selectedMonitorId : message.action === 'selected' ? null : runtime.snapshot.selectedMonitorId)
        : typeof message.monitorId === 'number' ? message.monitorId : runtime.snapshot.selectedMonitorId
      notify(runtime, { monitors, selectedMonitorId, monitorStatus: message.action === 'selected' ? 'Display selection applied.' : null })
      return
    }
    if (message.type === 'monitor' && message.action === 'error') {
      notify(runtime, { monitorStatus: message.reason ?? 'The display could not be selected.' })
      return
    }
    if (message.type === 'control' && message.action === 'clipboard_result' && typeof message.text === 'string') {
      notify(runtime, { remoteClipboard: message.text, clipboardStatus: 'Remote clipboard received.' })
      return
    }
    if (message.type === 'control' && message.action === 'clipboard_ack') {
      notify(runtime, { clipboardStatus: 'Clipboard sent to endpoint.' })
      return
    }
    if (message.type === 'control' && message.action === 'clipboard_error') {
      notify(runtime, { clipboardStatus: message.reason ?? 'Clipboard operation failed.' })
      return
    }
    if (message.type === 'terminal' && message.action === 'ready') {
      notify(runtime, { terminalReady: true, terminalStatus: 'Elevated terminal ready.' })
      return
    }
    if (message.type === 'terminal' && message.action === 'output' && typeof message.text === 'string') {
      notify(runtime, { terminalOutput: `${runtime.snapshot.terminalOutput}${message.text}`, terminalStatus: null })
      return
    }
    if (message.type === 'terminal' && message.action === 'error') {
      notify(runtime, { terminalStatus: message.reason ?? 'Terminal operation failed.' })
      return
    }
    if (message.type === 'terminal' && message.action === 'closed') {
      notify(runtime, { terminalReady: false, terminalStatus: 'Terminal closed.' })
      return
    }
    if (message.type === 'files' && message.action === 'list_result' && Array.isArray(message.entries)) {
      notify(runtime, {
        filePath: typeof message.path === 'string' ? message.path : '',
        fileRoot: typeof message.root === 'string' ? message.root : '',
        fileEntries: message.entries as Array<{ name: string; directory: boolean; size: number }>,
        fileStatus: null,
      })
      return
    }
    if (message.type === 'files' && message.action === 'download_start') {
      notify(runtime, {
        downloadName: typeof message.name === 'string' ? message.name : 'download',
        downloadData: '',
        fileStatus: 'Receiving file…',
      })
      return
    }
    if (message.type === 'files' && message.action === 'download_chunk' && typeof message.data === 'string') {
      notify(runtime, { downloadData: `${runtime.snapshot.downloadData ?? ''}${message.data}` })
      return
    }
    if (message.type === 'files' && message.action === 'download_end') {
      notify(runtime, { fileStatus: 'File ready to download.' })
      return
    }
    if (message.type === 'files' && message.action === 'upload_complete') {
      notify(runtime, { fileStatus: 'File uploaded successfully.' })
      return
    }
    if (message.type === 'files' && message.action === 'error') {
      notify(runtime, { fileStatus: message.reason ?? 'File operation failed.' })
      return
    }
    if (message.type === 'sysdata' && message.action === 'process_result' && Array.isArray(message.processes)) {
      notify(runtime, { processes: message.processes as Array<{ pid: number; name: string; cpu: number; memory: number; user?: string }>, sysdataStatus: null })
      return
    }
    if (message.type === 'sysdata' && message.action === 'service_result' && Array.isArray(message.services)) {
      notify(runtime, { services: message.services as Array<{ name: string }>, sysdataStatus: null })
      return
    }
    if (message.type === 'sysdata' && message.action === 'action_ack') {
      notify(runtime, { sysdataStatus: 'System action completed.' })
      return
    }
    if (message.type === 'sysdata' && message.action === 'error') {
      notify(runtime, { sysdataStatus: message.reason ?? 'System action failed.' })
      return
    }
    if (message.type === 'cursor' && typeof message.x === 'number' && typeof message.y === 'number') {
      notify(runtime, {
        remoteCursor: {
          x: Math.min(1, Math.max(0, message.x)),
          y: Math.min(1, Math.max(0, message.y)),
          visible: message.visible !== false,
          embedded: message.embedded === true,
        },
      })
    }
  } catch {
    // Ignore non-JSON control messages from the endpoint.
  }
}

function configureDataChannel(runtime: Runtime, channel: RTCDataChannel): void {
  if (channel.label === 'input') {
    runtime.inputChannel = channel
    channel.onopen = () => notify(runtime, { state: 'connected' })
    channel.onclose = () => {
      if (runtime.inputChannel === channel) runtime.inputChannel = null
      notify(runtime, { controlArmed: false })
    }
    return
  }

  if (channel.label === 'sysdata') {
    runtime.sysdataChannel = channel
    channel.onopen = () => notify(runtime, { state: 'connected', sysdataChannelReady: true })
    channel.onclose = () => {
      if (runtime.sysdataChannel === channel) runtime.sysdataChannel = null
      notify(runtime, { sysdataChannelReady: false })
    }
    channel.onmessage = (event) => handleControlMessage(runtime, event)
    return
  }

  if (channel.label === 'files') {
    runtime.fileChannel = channel
    channel.onopen = () => notify(runtime, { state: 'connected', fileChannelReady: true })
    channel.onclose = () => {
      if (runtime.fileChannel === channel) runtime.fileChannel = null
      notify(runtime, { fileChannelReady: false })
    }
    channel.onmessage = (event) => handleControlMessage(runtime, event)
    return
  }

  if (channel.label === 'terminal') {
    runtime.terminalChannel = channel
    channel.onopen = () => notify(runtime, { state: 'connected', terminalChannelReady: true })
    channel.onclose = () => {
      if (runtime.terminalChannel === channel) runtime.terminalChannel = null
      notify(runtime, { terminalChannelReady: false, terminalReady: false })
    }
    channel.onmessage = (event) => handleControlMessage(runtime, event)
    return
  }

  runtime.controlChannel = channel
  channel.onopen = () => {
    notify(runtime, { state: 'connected', controlArmed: true })
    send(runtime, { type: 'control', action: 'presence', status: 'technician_ready' })
    send(runtime, { type: 'control', action: 'monitor_list' })
  }
  channel.onclose = () => {
    if (runtime.controlChannel === channel) runtime.controlChannel = null
    notify(runtime, { controlArmed: false })
  }
  channel.onmessage = (event) => handleControlMessage(runtime, event)
}

function makePeer(runtime: Runtime): RTCPeerConnection {
  if (runtime.peer) return runtime.peer
  const peer = new RTCPeerConnection({
    iceServers: runtime.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }],
  })
  peer.addTransceiver('video', { direction: 'recvonly' })
  configureDataChannel(runtime, peer.createDataChannel('control', { ordered: true }))
  configureDataChannel(runtime, peer.createDataChannel('input', { ordered: false, maxRetransmits: 0 }))
  configureDataChannel(runtime, peer.createDataChannel('terminal', { ordered: true }))
  configureDataChannel(runtime, peer.createDataChannel('files', { ordered: true }))
  configureDataChannel(runtime, peer.createDataChannel('sysdata', { ordered: true }))
  peer.ondatachannel = (event) => configureDataChannel(runtime, event.channel)
  peer.onicecandidate = (event) => {
    if (event.candidate) send(runtime, { type: 'ice', candidate: event.candidate.toJSON() })
  }
  peer.ontrack = (event) => {
    const stream = event.streams[0] ?? new MediaStream([event.track])
    // Do not report a usable session until the screen track is actually
    // attached. Data channels can open before media, which previously made the
    // console look connected while showing a blank stage.
    notify(runtime, { remoteStream: stream, state: 'connected', error: null })
  }
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') notify(runtime, { state: 'connected' })
    if (peer.connectionState === 'failed') {
      notify(runtime, {
        state: 'error',
        error: 'WebRTC could not establish a media path. Check LAN routing or TURN configuration.',
      })
    }
    if (peer.connectionState === 'disconnected') notify(runtime, { state: 'waiting' })
  }
  runtime.peer = peer
  return peer
}

async function fetchIceServers(runtime: Runtime): Promise<RTCIceServer[]> {
  try {
    const { iceServers } = await api<{ iceServers: RTCIceServer[] }>(`/sessions/${runtime.id}/ice`)
    if (iceServers && iceServers.length > 0) return iceServers
  } catch {
    // The public STUN fallback below keeps LAN-direct sessions working without a TURN deployment.
  }
  return [{ urls: 'stun:stun.l.google.com:19302' }]
}

async function connect(runtime: Runtime, joinToken: string): Promise<void> {
  try {
    runtime.iceServers = await fetchIceServers(runtime)
    const socket = new WebSocket(relayUrl())
    runtime.socket = socket
    let waitTimer: number | undefined
    const clearWait = () => {
      if (waitTimer !== undefined) {
        window.clearTimeout(waitTimer)
        waitTimer = undefined
      }
    }
    const armWait = () => {
      if (waitTimer !== undefined) return
      waitTimer = window.setTimeout(() => {
        waitTimer = undefined
        if (runtime.socket !== socket) return
        if (['connecting', 'waiting', 'negotiating'].includes(runtime.snapshot.state)) {
          notify(runtime, {
            state: 'error',
            error: 'The endpoint has not connected yet. Ask the user to open the helper or check their network, then reconnect.',
          })
        }
      }, 30_000)
    }
    socket.onopen = () => {
      notify(runtime, { state: 'connecting', error: null })
      socket.send(JSON.stringify({ type: 'join', sessionId: runtime.id, joinToken }))
      armWait()
    }
    socket.onerror = () => notify(runtime, {
      state: 'error',
      error: 'The relay could not be reached. Confirm the relay is running and the endpoint is online.',
    })
    socket.onclose = () => {
      clearWait()
      if (runtime.snapshot.state !== 'ended') notify(runtime, { state: 'waiting' })
    }

    const addRemoteIce = async (candidate: RTCIceCandidateInit) => {
      const peer = makePeer(runtime)
      if (!peer.remoteDescription) {
        runtime.pendingIce.push(candidate)
        return
      }
      await peer.addIceCandidate(candidate)
    }

    const flushRemoteIce = async (peer: RTCPeerConnection) => {
      const pending = runtime.pendingIce.splice(0)
      for (const candidate of pending) await peer.addIceCandidate(candidate)
    }

    const offerEndpoint = async () => {
      const peer = makePeer(runtime)
      notify(runtime, { state: 'negotiating' })
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      send(runtime, { type: 'sdp', description: peer.localDescription })
    }

    socket.onmessage = (event) => {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(event.data as string) as Record<string, unknown>
      } catch {
        notify(runtime, { state: 'error', error: 'The relay returned an invalid message.' })
        return
      }
      if (message.type === 'joined') {
        notify(runtime, { state: 'waiting' })
        armWait()
        return
      }
      if (message.type === 'peer_joined') {
        clearWait()
        // Only the native endpoint helper publishes screen media. Browser
        // companions join as chat-only peers and must never trigger another
        // WebRTC offer.
        if (message.audience === 'agent') void offerEndpoint().catch((error) => notify(runtime, {
          state: 'error',
          error: error instanceof Error ? error.message : 'Could not create the browser media offer.',
        }))
        return
      }
      if (message.type === 'sdp') {
        const description = message.description as RTCSessionDescriptionInit | undefined
        if (!description) return
        void (async () => {
          const peer = makePeer(runtime)
          await peer.setRemoteDescription(description)
          await flushRemoteIce(peer)
          if (description.type === 'offer') {
            const answer = await peer.createAnswer()
            await peer.setLocalDescription(answer)
            send(runtime, { type: 'sdp', description: peer.localDescription })
          }
        })().catch(() => notify(runtime, {
          state: 'error',
          error: 'The endpoint could not negotiate a secure media connection.',
        }))
        return
      }
      if (message.type === 'ice' && message.candidate) {
        void addRemoteIce(message.candidate as RTCIceCandidateInit).catch(() => notify(runtime, {
          state: 'error',
          error: 'The browser could not apply the endpoint ICE candidate.',
        }))
        return
      }
      if (message.type === 'chat' && typeof message.body === 'string') {
        const rawAttachment = message.attachment as { kind?: string; name?: string; dataUrl?: string } | undefined
        const attachment: ChatAttachment | undefined = rawAttachment && (rawAttachment.kind === 'image' || rawAttachment.kind === 'file')
          ? { kind: rawAttachment.kind, name: rawAttachment.name, dataUrl: rawAttachment.dataUrl }
          : undefined
        notify(runtime, {
          chatMessages: [
            ...runtime.snapshot.chatMessages,
            {
              senderType: typeof message.from === 'string' ? message.from : 'system',
              body: message.body,
              createdAt: new Date().toISOString(),
              attachment,
            },
          ],
          typingUser: null,
        })
        return
      }
      if (message.type === 'typing') {
        const active = message.active !== false
        notify(runtime, {
          typingUser: active ? (typeof message.from === 'string' ? message.from : 'peer') : null,
        })
        return
      }
      if (message.type === 'session_end') {
        disposeSessionRuntime(runtime.id)
        return
      }
      if (message.type === 'error') {
        notify(runtime, {
          state: 'error',
          error: message.code === 'invalid_join_ticket' ? 'This session join ticket is invalid or expired.' : `Relay error: ${String(message.code ?? 'unknown')}`,
        })
      }
    }
  } catch (error) {
    notify(runtime, {
      state: 'error',
      error: error instanceof Error ? error.message : 'Could not open the remote session',
    })
  }
}

function createRuntime(id: string): Runtime {
  return {
    id,
    socket: null,
    peer: null,
    iceServers: null,
    controlChannel: null,
    inputChannel: null,
    terminalChannel: null,
    fileChannel: null,
    sysdataChannel: null,
    pendingIce: [],
    listeners: new Set(),
    snapshot: {
      state: 'authorizing',
      error: null,
      remoteStream: null,
      remoteCursor: null,
      monitors: [],
      selectedMonitorId: null,
      monitorStatus: null,
      controlArmed: false,
      presence: 'waiting',
      remoteClipboard: null,
      clipboardStatus: null,
      chatMessages: [],
      typingUser: null,
      terminalChannelReady: false,
      terminalReady: false,
      terminalOutput: '',
      terminalStatus: null,
      fileChannelReady: false,
      fileEntries: [],
      filePath: '',
      fileRoot: '',
      fileStatus: null,
      downloadName: null,
      downloadData: null,
      sysdataChannelReady: false,
      processes: [],
      services: [],
      sysdataStatus: null,
    },
  }
}

export function hasSessionRuntime(id: string): boolean {
  return runtimes.has(id)
}

export function subscribeSessionRuntime(id: string, joinToken: string | undefined, listener: RuntimeListener): () => void {
  let runtime = runtimes.get(id)
  if (!runtime) {
    runtime = createRuntime(id)
    runtimes.set(id, runtime)
    if (joinToken) void connect(runtime, joinToken)
  }
  runtime.listeners.add(listener)
  listener(runtime.snapshot)
  return () => {
    runtime?.listeners.delete(listener)
  }
}

export function sendSessionControl(id: string, payload: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return
  const runtime = runtimes.get(id)
  if (!runtime?.snapshot.controlArmed || runtime.controlChannel?.readyState !== 'open') return
  runtime.controlChannel.send(JSON.stringify({ type: 'control', ...payload }))
}

export function sendSessionSystem(id: string, payload: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return
  const runtime = runtimes.get(id)
  if (!runtime?.snapshot.controlArmed || !runtime.snapshot.sysdataChannelReady || runtime.sysdataChannel?.readyState !== 'open') return
  runtime.sysdataChannel.send(JSON.stringify({ type: 'sysdata', ...payload }))
}

export function sendSessionFiles(id: string, payload: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return
  const runtime = runtimes.get(id)
  if (!runtime?.snapshot.controlArmed || !runtime.snapshot.fileChannelReady || runtime.fileChannel?.readyState !== 'open') return
  runtime.fileChannel.send(JSON.stringify({ type: 'files', ...payload }))
}

export function sendSessionTerminal(id: string, payload: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return
  const runtime = runtimes.get(id)
  if (!runtime?.snapshot.controlArmed || !runtime.snapshot.terminalChannelReady || runtime.terminalChannel?.readyState !== 'open') return
  runtime.terminalChannel.send(JSON.stringify({ type: 'terminal', ...payload }))
}

export function sendSessionInput(id: string, payload: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return
  const runtime = runtimes.get(id)
  if (!runtime?.snapshot.controlArmed || runtime.inputChannel?.readyState !== 'open') return
  runtime.inputChannel.send(JSON.stringify({ type: 'input', ...payload }))
}

export function sendSessionChat(id: string, body: string): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  send(runtime, { type: 'chat', body })
}

export function sendSessionTyping(id: string, active: boolean): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  send(runtime, { type: 'typing', active })
}

export function appendSessionChat(id: string, message: SessionChatMessage): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  notify(runtime, { chatMessages: [...runtime.snapshot.chatMessages, message] })
}

export function sendSessionChatWithAttachment(id: string, body: string, attachment: ChatAttachment): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  send(runtime, { type: 'chat', body, attachment })
}

export function isSessionRuntimeAlive(id: string): boolean {
  const runtime = runtimes.get(id)
  return Boolean(runtime?.socket && runtime.socket.readyState === WebSocket.OPEN)
}

export function reconnectSessionRuntime(id: string, joinToken: string): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtime.socket?.close()
  runtime.peer?.close()
  runtime.socket = null
  runtime.peer = null
  runtime.controlChannel = null
  runtime.inputChannel = null
  runtime.terminalChannel = null
  runtime.fileChannel = null
  runtime.sysdataChannel = null
  runtime.pendingIce = []
  notify(runtime, { state: 'authorizing', error: null, remoteStream: null, remoteCursor: null, controlArmed: false, presence: 'waiting' })
  if (joinToken) void connect(runtime, joinToken)
}

export function endSessionRuntime(id: string): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  send(runtime, { type: 'session_end' })
  disposeSessionRuntime(id)
}

export function disposeSessionRuntime(id: string): void {
  const runtime = runtimes.get(id)
  if (!runtime) return
  runtime.socket?.close()
  runtime.peer?.close()
  runtime.controlChannel = null
  runtime.inputChannel = null
  runtime.terminalChannel = null
  runtime.fileChannel = null
  runtime.sysdataChannel = null
  runtime.peer = null
  runtime.socket = null
  notify(runtime, { state: 'ended', controlArmed: false, remoteStream: null, presence: 'waiting' })
  runtimes.delete(id)
}
