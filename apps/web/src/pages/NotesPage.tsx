import { useEffect, useState, useRef, useCallback } from 'react'
import { Shell } from '../components/Shell.js'
import { Icon } from '../components/Icons.js'
import { Modal } from '../components/ui.js'
import {
  listNotes, createNote, updateNote, deleteNote,
  getColorStyle, NOTE_COLORS, readImageFile, readClipboardImages,
  type Note,
} from '../lib/notes.js'

function extractCanvasEditor(root: HTMLElement): { body: string; images: string[] } {
  const images: string[] = []
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('img.note-inline-image').forEach((image) => {
    images.push(image.getAttribute('src') ?? '')
    image.remove()
  })
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')))
  clone.querySelectorAll('div, p').forEach((element) => element.append(document.createTextNode('\n')))
  return {
    body: (clone.textContent ?? '').replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n').replace(/\n+$/, ''),
    images,
  }
}

function StickyNote({ note, onMove, onResize, onContent, onColor, onPin, onImageOpen, onDelete }: {
  note: Note
  onMove: (id: number, x: number, y: number) => void
  onResize: (id: number, w: number, h: number) => void
  onContent: (id: number, body: string, images: string[]) => void
  onColor: (id: number, color: string) => void
  onPin: (id: number) => void
  onImageOpen: (src: string) => void
  onDelete: (id: number) => void
}) {
  const color = getColorStyle(note.color)
  const [, setBody] = useState(note.body)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const [saving, setSaving] = useState(false)
  const width = Math.min(Math.max(note.width || 220, 180), 240)
  const height = Math.min(Math.max(note.height || 220, 180), 300)
  const images = note.images ?? []

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.innerHTML = ''
    if (note.body) editor.appendChild(document.createTextNode(note.body))
    for (const src of images) {
      editor.appendChild(document.createTextNode(editor.childNodes.length ? '\n' : ''))
      const image = document.createElement('img')
      image.className = 'note-inline-image'
      image.src = src
      image.alt = 'Pasted note image'
      editor.appendChild(image)
    }
    // Only initialise from the server when this note mounts. Parent state
    // updates must not replace the editor while the user is typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note.id])
  useEffect(() => () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current) }, [])

  const saveContent = (content: { body: string; images: string[] }) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    setBody(content.body)
    setSaving(true)
    saveTimerRef.current = window.setTimeout(() => {
      onContent(note.id, content.body, content.images)
      setSaving(false)
    }, 400)
  }

  const handleEditorInput = () => {
    if (!editorRef.current) return
    saveContent(extractCanvasEditor(editorRef.current))
  }

  const insertImages = (sources: string[]) => {
    const editor = editorRef.current
    if (!editor || sources.length === 0) return
    editor.focus()
    const selection = window.getSelection()
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange()
    if (!editor.contains(range.commonAncestorContainer)) {
      range.selectNodeContents(editor)
      range.collapse(false)
    }
    sources.forEach((src) => {
      const image = document.createElement('img')
      image.className = 'note-inline-image'
      image.src = src
      image.alt = 'Pasted note image'
      range.insertNode(image)
      range.setStartAfter(image)
      range.collapse(true)
      range.insertNode(document.createTextNode(' '))
      range.collapse(true)
    })
    selection?.removeAllRanges()
    selection?.addRange(range)
    saveContent(extractCanvasEditor(editor))
  }

  const addImages = (files: File[]) => {
    if (files.length === 0) return
    Promise.all(files.map(readImageFile)).then(insertImages).catch(() => {})
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    const files = readClipboardImages(event.clipboardData)
    if (files.length === 0) return
    event.preventDefault()
    void Promise.all(files.map(readImageFile)).then(insertImages).catch(() => {})
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

      <div
        ref={editorRef}
        className="sticky-body-input sticky-body-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Note content"
        data-placeholder="Write something…"
        onInput={handleEditorInput}
        onPaste={handlePaste}
        onClick={(event) => {
          const target = event.target as HTMLElement
          if (target.tagName === 'IMG') onImageOpen((target as HTMLImageElement).src)
        }}
        style={{ color: color.text }}
      />

      <footer className="sticky-footer" style={{ borderTopColor: color.border }}>
        <div className="sticky-color-row" aria-label="Note background color">
          {NOTE_COLORS.map((item) => <button type="button" key={item.name} className={`sticky-color-dot${note.color === item.name ? ' active' : ''}`} style={{ background: item.border }} onClick={() => onColor(note.id, item.name)} title={`Use ${item.name} background`} aria-label={`Use ${item.name} background`} />)}
        </div>
        <label className="sticky-image-add" title="Add image" aria-label="Add image">
          <Icon name="upload" size={13} />
          <input type="file" accept="image/*" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length > 0) addImages(files) }} />
        </label>
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
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxZoom, setLightboxZoom] = useState(100)
  const searchRef = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const layoutTimersRef = useRef<Record<string, number>>({})

  useEffect(() => {
    listNotes().then((result) => setNotes(result.notes)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => { if (searchOpen) searchRef.current?.focus() }, [searchOpen])

  const scheduleLayoutSave = useCallback((id: number, patch: { position_x?: number; position_y?: number; width?: number; height?: number }) => {
    const key = String(id)
    const existing = layoutTimersRef.current[key]
    if (existing) window.clearTimeout(existing)
    layoutTimersRef.current[key] = window.setTimeout(() => {
      delete layoutTimersRef.current[key]
      updateNote(id, patch).catch(() => {})
    }, 350)
  }, [])

  const handleMove = useCallback((id: number, x: number, y: number) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, position_x: x, position_y: y } : note))
    scheduleLayoutSave(id, { position_x: x, position_y: y })
  }, [scheduleLayoutSave])

  const handleResize = useCallback((id: number, width: number, height: number) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, width, height } : note))
    scheduleLayoutSave(id, { width, height })
  }, [scheduleLayoutSave])

  const handleContent = useCallback((id: number, body: string, images: string[]) => {
    setNotes((prev) => prev.map((note) => note.id === id ? { ...note, body, images } : note))
    updateNote(id, { body, images }).catch(() => {})
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
        {workspaceNotes.length > 0 ? <div className="notes-canvas" ref={canvasRef}>{workspaceNotes.map((note) => <StickyNote key={note.id} note={note} onMove={handleMove} onResize={handleResize} onContent={handleContent} onColor={handleColor} onPin={handlePin} onImageOpen={(src) => { setLightboxSrc(src); setLightboxZoom(100) }} onDelete={handleDelete} />)}</div> : null}
        <Modal open={Boolean(lightboxSrc)} onClose={() => setLightboxSrc(null)} title="Note image" width={900}>
          {lightboxSrc ? <div className="notes-lightbox"><div className="notes-lightbox-toolbar"><span className="mono">{lightboxZoom}%</span><div><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLightboxZoom((value) => Math.max(25, value - 25))}><Icon name="minus" size={14} />Zoom out</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLightboxZoom((value) => Math.min(300, value + 25))}><Icon name="add" size={14} />Zoom in</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setLightboxZoom(100)}>Reset</button><a className="btn btn-primary btn-sm" href={lightboxSrc} download="reydesk-note-image.png"><Icon name="download" size={14} />Download</a></div></div><div className="notes-lightbox-stage"><img src={lightboxSrc} alt="Note attachment" style={{ width: `${lightboxZoom}%` }} /></div></div> : null}
        </Modal>
      </>}
    </Shell>
  )
}
