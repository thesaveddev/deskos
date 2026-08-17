import { useCallback, useEffect, useRef, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert } from '../components/ui.js'
import { createChatRoom, listChatMessages, listChatRooms, sendChatMessage, type ChatMessage, type ChatRoom } from '../lib/chat.js'
import { useAuth } from '../lib/auth.js'

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null)
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [newRoomName, setNewRoomName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const threadRef = useRef<HTMLDivElement | null>(null)

  const loadRooms = useCallback(async () => {
    try {
      setRooms((await listChatRooms()).rooms)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load rooms')
    }
  }, [])

  const loadMessages = useCallback(async (roomId: string) => {
    try {
      setMessages((await listChatMessages(roomId)).messages)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages')
    }
  }, [])

  useEffect(() => {
    void loadRooms()
  }, [loadRooms])

  useEffect(() => {
    if (!activeRoomId) return
    void loadMessages(activeRoomId)
    const timer = setInterval(() => void loadMessages(activeRoomId), 3000)
    return () => clearInterval(timer)
  }, [activeRoomId, loadMessages])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight })
  }, [messages])

  const activeRoom = rooms?.find((r) => r.id === activeRoomId) ?? null

  const send = async () => {
    if (!activeRoomId || !draft.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await sendChatMessage(activeRoomId, draft.trim())
      setDraft('')
      await loadMessages(activeRoomId)
      await loadRooms()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
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
        <h1 className="page-title">Team chat</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}

      <div className="chat-layout">
        <aside className="chat-rooms">
          <div className="chat-rooms-head">
            <span className="etch">Rooms</span>
            <input
              className="field-input"
              placeholder="New room…"
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void createRoom() }}
            />
            <button className="btn btn-ghost btn-sm" disabled={busy || !newRoomName.trim()} onClick={() => void createRoom()}>
              Add
            </button>
          </div>
          {rooms === null ? (
            <span className="etch">Loading rooms…</span>
          ) : rooms.length === 0 ? (
            <span className="muted">No rooms yet. Create one to start chatting.</span>
          ) : (
            <ul className="chat-room-list">
              {rooms.map((room) => (
                <li key={room.id}>
                  <button
                    className={`chat-room-item${room.id === activeRoomId ? ' active' : ''}`}
                    onClick={() => setActiveRoomId(room.id)}
                  >
                    <span className="chat-room-name"># {room.name}</span>
                    <span className="muted mono">{room.message_count}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="chat-thread-wrap">
          {!activeRoom ? (
            <div className="chat-empty muted">Select a room to read and send messages.</div>
          ) : (
            <>
              <div className="chat-thread-head">
                <span className="etch">#{activeRoom.name}</span>
              </div>
              <div className="chat-thread" ref={threadRef}>
                {messages.length === 0 ? (
                  <div className="muted" style={{ padding: '8px 0' }}>No messages yet.</div>
                ) : (
                  messages.map((m) => (
                    <div key={String(m.id)} className={`chat-message${m.sender_id === user?.id ? ' mine' : ''}`}>
                      <div className="chat-message-meta mono">
                        <span className="chat-message-author">{m.sender_name ?? 'Unknown'}</span>
                        <span>{formatTime(m.created_at)}</span>
                      </div>
                      <div className="chat-message-body">{m.body}</div>
                    </div>
                  ))
                )}
              </div>
              <div className="chat-composer">
                <textarea
                  className="composer-input"
                  rows={2}
                  placeholder="Message…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void send()
                  }}
                />
                <button className="btn btn-primary btn-sm" disabled={busy || !draft.trim()} onClick={() => void send()}>
                  Send
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </Shell>
  )
}
