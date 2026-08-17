import { useEffect, useState, useRef, useCallback } from 'react'
import { listNotes, createNote, deleteNote, type Note } from '../lib/notes.js'

interface Props {
  open: boolean
  onClose: () => void
}

export function NotesDropdown({ open, onClose }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editBody, setEditBody] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await listNotes()
      setNotes(res.notes)
    } catch { /* ignore */ }
    setLoading(false)
  }, [])

  useEffect(() => {
    if (open) {
      void load()
      setTimeout(() => searchRef.current?.focus(), 100)
    }
  }, [open, load])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open, onClose])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const { note } = await createNote({
        title: 'New note',
        body: '',
        color: 'yellow',
        position_x: 100,
        position_y: 100,
      })
      setNotes((prev) => [note, ...prev])
      setEditingId(note.id)
      setEditTitle(note.title)
      setEditBody(note.body)
    } catch { /* ignore */ }
    setCreating(false)
  }

  const handleSave = async (id: number) => {
    const note = notes.find((n) => n.id === id)
    if (!note) return
    if (editTitle === note.title && editBody === note.body) {
      setEditingId(null)
      return
    }
    try {
      const res = await import('../lib/notes.js').then((m) => m.updateNote(id, { title: editTitle, body: editBody }))
      setNotes((prev) => prev.map((n) => n.id === id ? res.note : n))
    } catch { /* ignore */ }
    setEditingId(null)
  }

  const handleDelete = async (id: number) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    if (editingId === id) setEditingId(null)
    await deleteNote(id).catch(() => {})
  }

  const filtered = search
    ? notes.filter((n) => n.title.toLowerCase().includes(search.toLowerCase()) || n.body.toLowerCase().includes(search.toLowerCase()))
    : notes

  if (!open) return null

  return (
    <div className="notes-dropdown" ref={ref}>
      <div className="notes-dropdown-header">
        <button className="notes-dropdown-add" onClick={() => void handleCreate()} disabled={creating} title="New note">
          +
        </button>
        <h4 className="notes-dropdown-title">DeskOS Notes</h4>
        <button className="notes-dropdown-close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>

      <div className="notes-dropdown-search">
        <svg className="notes-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref={searchRef}
          className="notes-dropdown-search-input"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="notes-dropdown-list">
        {loading ? (
          <div className="notes-dropdown-empty">
            <span className="etch">Loading…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="notes-dropdown-empty">
            <span className="notes-dropdown-empty-icon">📝</span>
            <p><strong>{search ? 'No notes found' : 'No note yet.'}</strong></p>
            {!search && <p className="notes-dropdown-empty-hint">Click "+" to create a note.</p>}
          </div>
        ) : (
          filtered.map((note) => (
            <div key={note.id} className={`notes-dropdown-item ${editingId === note.id ? 'editing' : ''}`}>
              {editingId === note.id ? (
                <div className="notes-dropdown-edit">
                  <input
                    className="notes-dropdown-edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Title"
                    autoFocus
                  />
                  <textarea
                    className="notes-dropdown-edit-body"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder="Write something…"
                    rows={3}
                  />
                  <div className="notes-dropdown-edit-actions">
                    <button className="btn btn-primary btn-sm" onClick={() => void handleSave(note.id)}>Save</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="notes-dropdown-item-dot" style={{ background: note.color === 'yellow' ? '#f59e0b' : note.color === 'green' ? '#10b981' : note.color === 'blue' ? '#3b82f6' : note.color === 'pink' ? '#ec4899' : note.color === 'purple' ? '#8b5cf6' : note.color === 'orange' ? '#f97316' : '#9ca3af' }} />
                  <div className="notes-dropdown-item-content" onClick={() => { setEditingId(note.id); setEditTitle(note.title); setEditBody(note.body) }}>
                    <span className="notes-dropdown-item-title">{note.title || 'Untitled'}</span>
                    <span className="notes-dropdown-item-preview">{note.body || 'Empty note'}</span>
                  </div>
                  <button className="notes-dropdown-item-delete" onClick={() => void handleDelete(note.id)} title="Delete">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
