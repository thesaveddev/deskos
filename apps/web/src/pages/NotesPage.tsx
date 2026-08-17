import { useEffect, useState, useRef, useCallback, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import {
  listNotes, createNote, updateNote, deleteNote,
  getColorStyle, NOTE_COLORS,
  type Note,
} from '../lib/notes.js'

/* ── Single sticky note ──────────────────────────────────────── */

function StickyNote({ note, onMove, onResize, onEdit, onPin, onDelete }: {
  note: Note
  onMove: (id: number, x: number, y: number) => void
  onResize: (id: number, w: number, h: number) => void
  onEdit: (id: number, title: string, body: string) => void
  onPin: (id: number) => void
  onDelete: (id: number) => void
}) {
  const color = getColorStyle(note.color)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(note.title)
  const [body, setBody] = useState(note.body)
  const [showMenu, setShowMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showMenu])

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: note.position_x, origY: note.position_y }
    const onDragMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const dx = ev.clientX - dragRef.current.startX
      const dy = ev.clientY - dragRef.current.startY
      onMove(note.id, Math.max(0, dragRef.current.origX + dx), Math.max(0, dragRef.current.origY + dy))
    }
    const onDragUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', onDragMove)
      document.removeEventListener('mouseup', onDragUp)
    }
    document.addEventListener('mousemove', onDragMove)
    document.addEventListener('mouseup', onDragUp)
  }

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: note.width, origH: note.height }
    const onResizeMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return
      const dx = ev.clientX - resizeRef.current.startX
      const dy = ev.clientY - resizeRef.current.startY
      onResize(note.id, Math.max(180, resizeRef.current.origW + dx), Math.max(120, resizeRef.current.origH + dy))
    }
    const onResizeUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onResizeMove)
      document.removeEventListener('mouseup', onResizeUp)
    }
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeUp)
  }

  const handleBlur = () => {
    setEditing(false)
    if (title !== note.title || body !== note.body) {
      onEdit(note.id, title, body)
    }
  }

  return (
    <div
      className={`sticky-note ${note.is_pinned ? 'pinned' : ''}`}
      style={{
        left: note.position_x,
        top: note.position_y,
        width: note.width,
        height: note.height,
        background: color.bg,
        color: color.text,
        borderColor: color.border,
        zIndex: note.is_pinned ? 50 : 10,
      }}
    >
      {/* Title bar / drag handle */}
      <div
        className="sticky-header"
        style={{ borderBottomColor: color.border }}
        onMouseDown={handleDragStart}
      >
        {editing ? (
          <input
            className="sticky-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title"
            style={{ color: color.text }}
            autoFocus
          />
        ) : (
          <span className="sticky-title" onClick={() => setEditing(true)}>
            {note.title || 'Untitled'}
          </span>
        )}
        <div className="sticky-actions">
          <button
            className="sticky-action-btn"
            onClick={() => onPin(note.id)}
            title={note.is_pinned ? 'Unpin' : 'Pin to top'}
          >
            {note.is_pinned ? '📌' : '📍'}
          </button>
          <div className="sticky-menu-wrap" ref={menuRef}>
            <button className="sticky-action-btn" onClick={() => setShowMenu(!showMenu)} title="More">⋯</button>
            {showMenu && (
              <div className="sticky-menu">
                <div className="sticky-menu-section">Color</div>
                <div className="sticky-color-row">
                  {NOTE_COLORS.map((c) => (
                    <button
                      key={c.name}
                      className={`sticky-color-dot ${note.color === c.name ? 'active' : ''}`}
                      style={{ background: c.border }}
                      onClick={() => { updateNote(note.id, { color: c.name }); setShowMenu(false) }}
                      title={c.name}
                    />
                  ))}
                </div>
                <button className="sticky-menu-item danger" onClick={() => { onDelete(note.id); setShowMenu(false) }}>
                  Delete note
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="sticky-body" onClick={() => !editing && setEditing(true)}>
        {editing ? (
          <textarea
            className="sticky-body-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={handleBlur}
            placeholder="Write something…"
            style={{ color: color.text }}
          />
        ) : (
          <div className="sticky-body-text">
            {note.body || <span className="sticky-placeholder">Click to write…</span>}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div className="sticky-resize" onMouseDown={handleResizeStart} style={{ borderBottomColor: color.border, borderRightColor: color.border }} />
    </div>
  )
}

/* ── Notes Page ──────────────────────────────────────────────── */

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const canvasRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listNotes()
      .then((r) => setNotes(r.notes))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleMove = useCallback((id: number, x: number, y: number) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, position_x: x, position_y: y } : n))
  }, [])

  const handleResize = useCallback((id: number, w: number, h: number) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, width: w, height: h } : n))
  }, [])

  const handleEdit = useCallback((id: number, title: string, body: string) => {
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, title, body } : n))
    updateNote(id, { title, body }).catch(() => {})
  }, [])

  const handlePin = useCallback((id: number) => {
    const note = notes.find((n) => n.id === id)
    if (!note) return
    const pinned = !note.is_pinned
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, is_pinned: pinned } : n))
    updateNote(id, { is_pinned: pinned }).catch(() => {})
  }, [notes])

  const handleDelete = useCallback((id: number) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    deleteNote(id).catch(() => {})
  }, [])

  const handleNewNote = async () => {
    // Place new note near center of visible canvas
    const canvas = canvasRef.current
    const x = canvas ? Math.max(20, canvas.scrollLeft + canvas.clientWidth / 2 - 130) : 100
    const y = canvas ? Math.max(20, canvas.scrollTop + canvas.clientHeight / 2 - 130) : 100
    const randomColor = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)].name
    try {
      const { note } = await createNote({ color: randomColor, position_x: x, position_y: y })
      setNotes((prev) => [note, ...prev])
    } catch {
      /* silent */
    }
  }

  const filtered = search
    ? notes.filter((n) => n.title.toLowerCase().includes(search.toLowerCase()) || n.body.toLowerCase().includes(search.toLowerCase()))
    : notes

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Notes</h1>
        <div className="notes-toolbar">
          <input
            className="field-input"
            placeholder="Search notes…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <button className="btn btn-primary" onClick={handleNewNote}>+ New note</button>
        </div>
      </div>

      {loading ? (
        <div className="dash-loading"><div className="loading-spinner" /><p>Loading notes…</p></div>
      ) : filtered.length === 0 ? (
        <div className="dash-empty-state">
          <span style={{ fontSize: '2.5rem' }}>📝</span>
          <p>{search ? 'No notes match your search' : 'No notes yet'}</p>
          {!search && <button className="btn btn-primary" onClick={handleNewNote}>Create your first note</button>}
        </div>
      ) : (
        <div className="notes-canvas" ref={canvasRef}>
          {filtered.map((note) => (
            <StickyNote
              key={note.id}
              note={note}
              onMove={handleMove}
              onResize={handleResize}
              onEdit={handleEdit}
              onPin={handlePin}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </Shell>
  )
}
