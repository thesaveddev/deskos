import { useEffect, useState, useRef, useCallback } from 'react'
import { listNotes, createNote, deleteNote, updateNote, type Note } from '../lib/notes.js'

const COLOR_MAP: Record<string, { bg: string; text: string; dot: string }> = {
  yellow: { bg: '#fef9c3', text: '#713f12', dot: '#ca8a04' },
  green: { bg: '#dcfce7', text: '#14532d', dot: '#16a34a' },
  blue: { bg: '#dbeafe', text: '#1e3a8a', dot: '#2563eb' },
  pink: { bg: '#fce7f3', text: '#831843', dot: '#db2777' },
  purple: { bg: '#f3e8ff', text: '#581c87', dot: '#9333ea' },
  orange: { bg: '#fff7ed', text: '#9a3412', dot: '#ea580c' },
  gray: { bg: '#f1f5f9', text: '#334155', dot: '#64748b' },
}

function getColor(c: string) { return COLOR_MAP[c] || COLOR_MAP.gray }

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
    if (open) { void load(); setTimeout(() => searchRef.current?.focus(), 100) }
  }, [open, load])

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [open, onClose])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const { note } = await createNote({ title: 'Uncategorized', body: '', color: 'gray', position_x: 100, position_y: 100 })
      setNotes((prev) => [note, ...prev])
      setEditingId(note.id)
      setEditTitle(note.title)
      setEditBody(note.body)
    } catch { /* ignore */ }
    setCreating(false)
  }

  const handleSave = async (id: number) => {
    try {
      const res = await updateNote(id, { title: editTitle, body: editBody })
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
        <button className="notes-dropdown-add" onClick={() => void handleCreate()} disabled={creating} title="New note">+</button>
        <h4 className="notes-dropdown-title">DeskOS Notes</h4>
        <button className="notes-dropdown-close" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="notes-dropdown-search">
        <svg className="notes-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          ref={searchRef}
          className="notes-dropdown-search-input"
          placeholder="Search..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="notes-dropdown-grid">
        {loading ? (
          <div className="notes-dropdown-empty"><span className="etch">Loading…</span></div>
        ) : filtered.length === 0 ? (
          <div className="notes-dropdown-empty">
            <p><strong>{search ? 'No notes found' : 'No note yet.'}</strong></p>
            {!search && <p className="notes-dropdown-empty-hint">Click "+" to create a note.</p>}
          </div>
        ) : (
          filtered.map((note) => {
            const c = getColor(note.color)
            if (editingId === note.id) {
              return (
                <div key={note.id} className="notes-card notes-card-editing">
                  <input
                    className="notes-card-edit-title"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="Category"
                    autoFocus
                  />
                  <textarea
                    className="notes-card-edit-body"
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    placeholder="Write something..."
                    rows={4}
                  />
                  <div className="notes-card-edit-actions">
                    <button className="btn btn-primary btn-xs" onClick={() => void handleSave(note.id)}>Save</button>
                    <button className="btn btn-ghost btn-xs" onClick={() => setEditingId(null)}>Cancel</button>
                    <button className="btn btn-xs notes-card-edit-color" style={{ background: c.dot }} onClick={() => {
                      const colors = Object.keys(COLOR_MAP)
                      const next = colors[(colors.indexOf(note.color) + 1) % colors.length]
                      updateNote(note.id, { color: next }).then(() => {
                        setNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, color: next } : n))
                      })
                    }} title="Change color" />
                  </div>
                </div>
              )
            }
            return (
              <div
                key={note.id}
                className="notes-card"
                style={{ background: c.bg, color: c.text }}
                onClick={() => { setEditingId(note.id); setEditTitle(note.title); setEditBody(note.body) }}
              >
                <div className="notes-card-header">
                  <span className="notes-card-dot" style={{ background: c.dot }} />
                  <span className="notes-card-category">{note.title || 'Untitled'}</span>
                </div>
                <div className="notes-card-body">
                  {note.body || <span className="notes-card-empty">Empty note</span>}
                </div>
                <div className="notes-card-footer">
                  <span className="notes-card-date">{new Date(note.updated_at || note.created_at).toLocaleDateString('en-CA')}</span>
                  <button
                    className="notes-card-delete"
                    onClick={(e) => { e.stopPropagation(); void handleDelete(note.id) }}
                    title="Delete"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
