import { useEffect, useState, useRef, useCallback } from 'react'
import { Shell } from '../components/Shell.js'
import { Icon } from '../components/Icons.js'
import {
  listNotes, createNote, updateNote, deleteNote,
  getColorStyle, NOTE_COLORS,
  type Note,
} from '../lib/notes.js'

function StickyNote({ note, onMove, onResize, onEdit, onColor, onPin, onDelete }: {
  note: Note
  onMove: (id: number, x: number, y: number) => void
  onResize: (id: number, w: number, h: number) => void
  onEdit: (id: number, body: string) => void
  onColor: (id: number, color: string) => void
  onPin: (id: number) => void
  onDelete: (id: number) => void
}) {
  const color = getColorStyle(note.color)
  const [body, setBody] = useState(note.body)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const [saving, setSaving] = useState(false)
  const width = Math.min(Math.max(note.width || 220, 180), 240)
  const height = Math.min(Math.max(note.height || 220, 180), 300)

  useEffect(() => setBody(note.body), [note.body])
  useEffect(() => () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current) }, [])

  const saveBody = (value: string) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setSaving(true)
    saveTimerRef.current = window.setTimeout(() => {
      onEdit(note.id, value)
      setSaving(false)
    }, 400)
  }

  const flushBody = () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    if (body !== note.body) onEdit(note.id, body)
    setSaving(false)
  }

  const handleDragStart = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest('button')) return
    event.preventDefault()
    dragRef.current = { startX: event.clientX, startY: event.clientY, origX: note.position_x, origY: note.position_y }
    const onDragMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return
      const dx = moveEvent.clientX - dragRef.current.startX
      const dy = moveEvent.clientY - dragRef.current.startY
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

  const handleResizeStart = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    resizeRef.current = { startX: event.clientX, startY: event.clientY, origW: width, origH: height }
    const onResizeMove = (moveEvent: MouseEvent) => {
      if (!resizeRef.current) return
      const dx = moveEvent.clientX - resizeRef.current.startX
      const dy = moveEvent.clientY - resizeRef.current.startY
      onResize(note.id, Math.min(240, Math.max(180, resizeRef.current.origW + dx)), Math.min(300, Math.max(180, resizeRef.current.origH + dy)))
    }
    const onResizeUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onResizeMove)
      document.removeEventListener('mouseup', onResizeUp)
    }
    document.addEventListener('mousemove', onResizeMove)
    document.addEventListener('mouseup', onResizeUp)
  }

  return (
    <article
      data-note-id={note.id}
      className={`sticky-note${note.is_pinned ? ' pinned' : ''}`}
      style={{ left: note.position_x, top: note.position_y, width, height, background: color.bg, color: color.text, borderColor: color.border, zIndex: note.is_pinned ? 50 : 10 }}
    >
      <header className="sticky-header" style={{ borderBottomColor: color.border }} onMouseDown={handleDragStart}>
        <span className="sticky-category">{note.category_name || 'Note'}</span>
        <div className="sticky-actions">
          <button type="button" className="sticky-action-btn" onClick={() => onPin(note.id)} title={note.is_pinned ? 'Unpin note' : 'Pin note'} aria-label={note.is_pinned ? 'Unpin note' : 'Pin note'}><Icon name="pin" size={13} /></button>
        </div>
      </header>

      <textarea
        className="sticky-body-input"
        value={body}
        onChange={(event) => { setBody(event.target.value); saveBody(event.target.value) }}
        onBlur={flushBody}
        placeholder="Write something…"
        aria-label="Note content"
        style={{ color: color.text }}
      />

      <footer className="sticky-footer" style={{ borderTopColor: color.border }}>
        <div className="sticky-color-row" aria-label="Note background color">
          {NOTE_COLORS.map((item) => <button type="button" key={item.name} className={`sticky-color-dot${note.color === item.name ? ' active' : ''}`} style={{ background: item.border }} onClick={() => onColor(note.id, item.name)} title={`Use ${item.name} background`} aria-label={`Use ${item.name} background`} />)}
        </div>
        <span className="sticky-save-state">{saving ? 'Saving…' : 'Saved'}</span>
        <button type="button" className="sticky-action-btn sticky-delete-btn" onClick={() => onDelete(note.id)} title="Delete note" aria-label="Delete note"><Icon name="delete" size={14} /></button>
      </footer>
      <div className="sticky-resize" onMouseDown={handleResizeStart} style={{ borderBottomColor: color.border, borderRightColor: color.border }} />
    </article>
  )
}

function PinnedNoteCard({ note, onUnpin, onOpen }: { note: Note; onUnpin: () => void; onOpen: () => void }) {
  const color = getColorStyle(note.color)
  return (
    <article className="notes-pinned-card" style={{ background: color.bg, color: color.text, borderColor: color.border }}>
      <div className="notes-pinned-card-head"><span className="notes-pinned-card-title">{note.category_name || 'Note'}</span><Icon name="pin" size={13} /></div>
      <p>{note.body || 'Empty note'}</p>
      <div className="notes-pinned-card-actions"><button type="button" className="notes-pinned-open" onClick={onOpen}>Open note</button><button type="button" className="notes-pinned-unpin" onClick={onUnpin}>Unpin</button></div>
    </article>
  )
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    listNotes().then((result) => setNotes(result.notes)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  const handleMove = useCallback((id: number, x: number, y: number) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, position_x: x, position_y: y } : note))
  }, [])

  const handleResize = useCallback((id: number, width: number, height: number) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, width, height } : note))
  }, [])

  const handleEdit = useCallback((id: number, body: string) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, body } : note))
    updateNote(id, { body }).catch(() => {})
  }, [])

  const handleColor = useCallback((id: number, color: string) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, color } : note))
    updateNote(id, { color }).catch(() => {})
  }, [])

  const handlePin = useCallback((id: number) => {
    const note = notes.find((item) => item.id === id)
    if (!note) return
    const isPinned = !note.is_pinned
    setNotes((prev) => prev.map((item) => item.id === id ? { ...item, is_pinned: isPinned } : item))
    updateNote(id, { is_pinned: isPinned }).catch(() => {})
  }, [notes])

  const handleDelete = useCallback((id: number) => {
    setNotes((prev) => prev.filter((note) => note.id !== id))
    deleteNote(id).catch(() => {})
  }, [])

  const handleNewNote = async () => {
    const canvas = canvasRef.current
    const x = canvas ? Math.max(20, canvas.scrollLeft + canvas.clientWidth / 2 - 110) : 100
    const y = canvas ? Math.max(20, canvas.scrollTop + canvas.clientHeight / 2 - 110) : 100
    const randomColor = NOTE_COLORS[Math.floor(Math.random() * NOTE_COLORS.length)].name
    try {
      const { note } = await createNote({ title: '', body: '', color: randomColor, width: 220, height: 220, position_x: x, position_y: y })
      setNotes((prev) => [note, ...prev])
    } catch { /* keep the workspace usable if the request fails */ }
  }

  const filtered = search.trim() ? notes.filter((note) => `${note.body} ${note.category_name ?? ''}`.toLowerCase().includes(search.toLowerCase())) : notes
  const pinnedNotes = filtered.filter((note) => note.is_pinned)
  const workspaceNotes = filtered.filter((note) => !note.is_pinned)

  useEffect(() => {
    const noteId = new URLSearchParams(window.location.search).get('note')
    if (!noteId || !notes.length) return
    window.setTimeout(() => document.querySelector(`[data-note-id="${noteId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
  }, [notes.length])

  return (
    <Shell>
      <div className="page-head notes-page-head">
        <div><h1 className="page-title">Notes</h1><p className="page-subtitle">Quick thoughts, kept close.</p></div>
        <div className="notes-toolbar">
          {searchOpen ? <div className="notes-page-search"><Icon name="search" size={15} /><input ref={searchRef} className="field-input" placeholder="Search notes…" value={search} onChange={(event) => setSearch(event.target.value)} /><button type="button" className="notes-search-close" onClick={() => { setSearch(''); setSearchOpen(false) }} aria-label="Close note search"><Icon name="close" size={14} /></button></div> : <button type="button" className="notes-search-toggle" onClick={() => setSearchOpen(true)} title="Search notes" aria-label="Search notes"><Icon name="search" size={18} /></button>}
          <button type="button" className="btn btn-primary" onClick={() => void handleNewNote()}><Icon name="add" size={15} />New note</button>
        </div>
      </div>

      {loading ? <div className="dash-loading"><div className="loading-spinner" /><p>Loading notes…</p></div> : filtered.length === 0 ? <div className="dash-empty-state"><Icon name="edit" size={30} /><p>{search ? 'No notes match your search' : 'No notes yet'}</p>{!search && <button type="button" className="btn btn-primary" onClick={() => void handleNewNote()}>Create your first note</button>}</div> : <>
        {pinnedNotes.length > 0 ? <section className="notes-pinned-strip" aria-label="Pinned notes"><div className="notes-pinned-strip-head"><div><span className="etch">Pinned</span><p>Notes you want at the top of the workspace.</p></div><span className="notes-pinned-count">{pinnedNotes.length}</span></div><div className="notes-pinned-list">{pinnedNotes.map((note) => <PinnedNoteCard key={note.id} note={note} onUnpin={() => handlePin(note.id)} onOpen={() => { window.history.replaceState({}, '', `/notes?note=${note.id}`); document.querySelector(`[data-note-id="${note.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }} />)}</div></section> : null}
        {workspaceNotes.length > 0 ? <div className="notes-canvas" ref={canvasRef}>{workspaceNotes.map((note) => <StickyNote key={note.id} note={note} onMove={handleMove} onResize={handleResize} onEdit={handleEdit} onColor={handleColor} onPin={handlePin} onDelete={handleDelete} />)}</div> : null}
      </>}
    </Shell>
  )
}
