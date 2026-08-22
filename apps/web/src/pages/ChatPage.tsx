import { useCallback, useEffect, useRef, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { Icon } from '../components/Icons.js'
import { createChatRoom, downloadChatAttachment, listChatMessages, listChatRooms, sendChatMessage, sendChatMessageWithFile, type ChatMessage, type ChatRoom } from '../lib/chat.js'
import { openNotificationStream } from '../lib/notifications.js'
import { useAuth } from '../lib/auth.js'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/')
}

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const tenantId = useAuth((s) => s.activeTenantId)
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [newRoomName, setNewRoomName] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [roomsLoading, setRoomsLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const threadRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const activeRoomRef = useRef<string | null>(null)

  const loadRooms = useCallback(async () => {
    setRoomsLoading(true)
    try {
      const next = (await listChatRooms()).rooms
      setRooms(next)
      setActiveRoomId((current) => current && next.some((room) => room.id === current) ? current : next[0]?.id ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms')
    } finally {
      setRoomsLoading(false)
    }
  }, [])

  const loadMessages = useCallback(async (roomId: string) => {
    setMessagesLoading(true)
    try {
      setMessages((await listChatMessages(roomId)).messages)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages')
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  useEffect(() => { void loadRooms() }, [loadRooms])

  useEffect(() => {
    activeRoomRef.current = activeRoomId
    if (!activeRoomId) {
      setMessages([])
      return
    }
    void loadMessages(activeRoomId)
  }, [activeRoomId, loadMessages])

  useEffect(() => {
    if (!tenantId) return
    return openNotificationStream({
      tenantId,
      onNotification: (notification) => {
        const roomId = notification.subject_id
        if (notification.kind === 'chat.message' && roomId && roomId === activeRoomRef.current) {
          void loadMessages(roomId)
        }
      },
    })
  }, [tenantId, loadMessages])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  const activeRoom = rooms?.find((r) => r.id === activeRoomId) ?? null

  const send = async () => {
    if (!activeRoomId || (!draft.trim() && !selectedFile) || busy) return
    setBusy(true)
    setError(null)
    try {
      if (selectedFile) await sendChatMessageWithFile(activeRoomId, draft.trim(), selectedFile)
      else await sendChatMessage(activeRoomId, draft.trim())
      setDraft('')
      setSelectedFile(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
      await loadMessages(activeRoomId)
      await loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = (file: File | undefined) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) {
      setError('Chat files must be 10 MB or smaller.')
      return
    }
    setError(null)
    setSelectedFile(file)
  }

  const createRoom = async () => {
    if (!newRoomName.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const { room } = await createChatRoom(newRoomName.trim())
      setNewRoomName('')
      await loadRooms()
      setActiveRoomId(room.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create room')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Shell>
      <div className="page-head">
        <div className="page-head-main">
          <h1 className="page-title">Team chat</h1>
          <p className="page-subtitle">Keep technical conversations and working files together for the team.</p>
        </div>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="chat-layout">
        <aside className="chat-rooms">
          <div className="chat-rooms-head">
            <span className="etch">Rooms</span>
            <div className="chat-room-create">
              <input
                className="field-input"
                placeholder="New room…"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void createRoom() }}
                aria-label="New room name"
              />
              <button className="btn btn-ghost btn-sm" aria-label="Create room" title="Create room" disabled={busy || !newRoomName.trim()} onClick={() => void createRoom()}>
                <Icon name="add" size={14} />
              </button>
            </div>
          </div>
          {roomsLoading ? (
            <div className="chat-room-state">Loading rooms…</div>
          ) : rooms?.length === 0 ? (
            <div className="chat-room-state"><strong>No rooms yet</strong><span>Create a room to start chatting.</span></div>
          ) : (
            <ul className="chat-room-list">
              {rooms?.map((room) => (
                <li key={room.id}>
                  <button
                    className={`chat-room-item${room.id === activeRoomId ? ' active' : ''}`}
                    onClick={() => setActiveRoomId(room.id)}
                  >
                    <span className="chat-room-name"><span aria-hidden="true">#</span>{room.name}</span>
                    <span className="muted mono">{room.message_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="chat-thread-wrap">
          {!activeRoom ? (
            <div className="chat-empty muted"><Icon name="chat" size={24} /><strong>Select a room</strong><span>Choose a room or create one to start a conversation.</span></div>
          ) : (
            <>
              <div className="chat-thread-head">
                <div><span className="etch">#{activeRoom.name}</span>{activeRoom.team_name ? <span className="chat-room-scope">Team room · {activeRoom.team_name}</span> : <span className="chat-room-scope">Organization room</span>}</div>
                <span className="muted mono">{messages.length} messages</span>
              </div>
              <div className="chat-thread" ref={threadRef} aria-live="polite">
                {messagesLoading && messages.length === 0 ? <div className="chat-message-state">Loading messages…</div> : null}
                {!messagesLoading && messages.length === 0 ? <div className="chat-message-state"><strong>No messages yet</strong><span>Send a message or share a file with the room.</span></div> : null}
                {messages.map((m) => (
                  <div key={String(m.id)} className={`chat-message${m.sender_id === user?.id ? ' mine' : ''}`}>
                    <div className="chat-message-meta mono">
                      <span className="chat-message-author">{m.sender_name ?? 'Unknown'}</span>
                      <span>{formatTime(m.created_at)}</span>
                    </div>
                    {m.body ? <div className="chat-message-body">{m.body}</div> : null}
                    {m.attachments?.length ? (
                      <div className="chat-attachments">
                        {m.attachments.map((attachment) => (
                          <button key={attachment.id} type="button" className="chat-attachment" onClick={() => void downloadChatAttachment(attachment.id, attachment.filename)} title={`Download ${attachment.filename}`}>
                            <span className="chat-attachment-icon"><Icon name={isImage(attachment.mime) ? 'image' : 'file'} size={16} /></span>
                            <span className="chat-attachment-copy"><strong>{attachment.filename}</strong><small>{formatBytes(Number(attachment.size_bytes))}</small></span>
                            <Icon name="download" size={14} />
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
              <div
                className={`chat-composer${dragActive ? ' drag-active' : ''}`}
                onDragEnter={(event) => { event.preventDefault(); setDragActive(true) }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false) }}
                onDrop={(event) => { event.preventDefault(); setDragActive(false); chooseFile(event.dataTransfer.files[0]) }}
              >
                {dragActive ? <div className="chat-drop-hint"><Icon name="upload" size={16} />Drop file to attach</div> : null}
                {selectedFile ? <div className="chat-selected-file"><Icon name="file" size={14} /><span>{selectedFile.name}</span><small>{formatBytes(selectedFile.size)}</small><button type="button" className="icon-btn" aria-label="Remove attachment" title="Remove attachment" onClick={() => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}><Icon name="close" size={14} /></button></div> : null}
                <textarea
                  className="composer-input"
                  rows={2}
                  placeholder="Write a message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void send()
                  }}
                />
                <div className="chat-composer-foot">
                  <div className="chat-composer-tools">
                    <input ref={fileInputRef} type="file" className="visually-hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()} title="Attach a file"><Icon name="paperclip" size={15} />Attach file</button>
                    <span className="muted chat-composer-hint">Up to 10 MB · Ctrl/Cmd + Enter to send</span>
                  </div>
                  <button className="btn btn-primary btn-sm" disabled={busy || (!draft.trim() && !selectedFile)} onClick={() => void send()}>
                    <Icon name="send" size={14} />{busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </Shell>
  )
}
