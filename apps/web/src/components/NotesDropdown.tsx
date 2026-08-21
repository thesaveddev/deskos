import { useEffect, useRef, useState, useCallback } from 'react'
import {
  listNotes, createNote, deleteNote, updateNote,
  listNoteCategories, createNoteCategory, deleteNoteCategory,
  getColorStyle, NOTE_COLORS, type Note, type NoteCategory,
} from '../lib/notes.js'
import { Icon } from './Icons.js'

interface Props { open: boolean; onClose: () => void }
type View = 'all' | 'note' | 'categories'

type Draft = { body: string; color: string; category_id: string; images: string[] }

function readImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** Read inline images (in DOM order) and the plain-text body out of the editor. */
function extractEditor(root: HTMLElement): { body: string; images: string[] } {
  const images: string[] = []
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll('img.note-inline-image').forEach((img) => {
    images.push(img.getAttribute('src') ?? '')
    img.remove()
  })
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')))
  clone.querySelectorAll('div, p').forEach((el) => el.append(document.createTextNode('\n')))
  const body = (clone.textContent ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/\n+$/, '')
  return { body, images }
}

export function NotesDropdown({ open, onClose }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [categories, setCategories] = useState<NoteCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [view, setView] = useState<View>('all')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [categoryFilter, setCategoryFilter] = useState('')
  const [categoryName, setCategoryName] = useState('')
  const [categoryColor, setCategoryColor] = useState('blue')
  const [creatingCategory, setCreatingCategory] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>({ body: '', color: 'yellow', category_id: '', images: [] })
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const saveTimerRef = useRef<number | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const selected = notes.find((note) => note.id === selectedId) ?? null

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [noteResult, categoryResult] = await Promise.all([listNotes(), listNoteCategories()])
      setNotes(noteResult.notes)
      setCategories(categoryResult.categories)
    } catch {
      setNotes([])
      setCategories([])
      setError('Notes could not be loaded. Please try again.')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (!open) return
    void load()
    setView('all')
    setSelectedId(null)
    setSearch('')
    setSearchOpen(false)
  }, [open, load])

  useEffect(() => {
    if (open && searchOpen) window.setTimeout(() => searchRef.current?.focus(), 0)
  }, [open, searchOpen])

  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [open, onClose])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
  }, [])

  // Populate the contenteditable body whenever a note is opened. Kept out of the
  // draft dependency list so typing never re-renders the editor and loses focus.
  useEffect(() => {
    if (view !== 'note' || !selectedId) return
    const root = editorRef.current
    if (!root) return
    root.innerHTML = ''
    root.appendChild(document.createTextNode(draft.body))
    draft.images.forEach((src) => {
      const img = document.createElement('img')
      img.className = 'note-inline-image'
      img.src = src
      img.alt = ''
      root.appendChild(img)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedId])

  const openNote = (note: Note) => {
    setSelectedId(note.id)
    setDraft({ body: note.body, color: note.color, category_id: note.category_id ?? '', images: note.images ?? [] })
    setError(null)
    setView('note')
  }

  const handleCreate = async () => {
    setSaving(true)
    setError(null)
    try {
      const result = await createNote({ title: '', body: '', color: 'yellow', category_id: categoryFilter || null, images: [] })
      setNotes((items) => [result.note, ...items])
      openNote(result.note)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The note could not be created. Please try again.')
    } finally { setSaving(false) }
  }

  const persist = (patch: Partial<Draft>) => {
    if (!selected) return
    const next = { ...draft, ...patch }
    setDraft(next)
    setError(null)
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      setSaving(true)
      try {
        const result = await updateNote(selected.id, {
          body: next.body,
          color: next.color,
          category_id: next.category_id || null,
          images: next.images,
        })
        setNotes((items) => items.map((item) => item.id === selected.id ? result.note : item))
      } catch {
        setError('Changes could not be saved. Please try again.')
      } finally { setSaving(false) }
    }, 350)
  }

  const handleEditorInput = () => {
    if (!editorRef.current || !selected) return
    const { body, images } = extractEditor(editorRef.current)
    persist({ body, images })
  }

  const handleEditorKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      document.execCommand('insertText', false, '\n')
    }
  }

  const addImages = (files: File[]) => {
    if (!selected || files.length === 0) return
    Promise.all(files.map(readImage))
      .then((sources) => {
        const root = editorRef.current
        if (root) {
          sources.forEach((src, index) => {
            if (index === 0 && (root.textContent ?? '').trim() !== '') {
              root.appendChild(document.createTextNode('\n'))
            }
            const img = document.createElement('img')
            img.className = 'note-inline-image'
            img.src = src
            img.alt = ''
            root.appendChild(img)
          })
          const { body, images } = extractEditor(root)
          persist({ body, images })
        } else {
          persist({ images: [...draft.images, ...sources] })
        }
      })
      .catch(() => setError('The image could not be added.'))
  }

  const removeImage = (index: number) => {
    const root = editorRef.current
    if (!root) return
    root.querySelectorAll('img.note-inline-image')[index]?.remove()
    const { body, images } = extractEditor(root)
    persist({ body, images })
  }

  const removeNote = async (id: number) => {
    setNotes((items) => items.filter((item) => item.id !== id))
    if (selectedId === id) { setSelectedId(null); setView('all') }
    await deleteNote(id).catch(() => setError('The note could not be deleted.'))
  }

  const togglePin = async (note: Note) => {
    try {
      const result = await updateNote(note.id, { is_pinned: !note.is_pinned })
      setNotes((items) => items.map((item) => item.id === note.id ? result.note : item))
    } catch { setError('The note could not be updated.') }
  }

  const addCategory = async () => {
    const name = categoryName.trim()
    if (!name || creatingCategory) return
    setCreatingCategory(true)
    setError(null)
    try {
      const result = await createNoteCategory({ name, color: categoryColor })
      setCategories((items) => [...items, result.category].sort((a, b) => a.name.localeCompare(b.name)))
      setCategoryName('')
      setCategoryColor('blue')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The category could not be created. Please try again.')
    } finally { setCreatingCategory(false) }
  }

  const filtered = notes.filter((note) => {
    const matchesSearch = !search || `${note.body} ${note.category_name ?? ''}`.toLowerCase().includes(search.toLowerCase())
    return matchesSearch && (!categoryFilter || note.category_id === categoryFilter)
  }).sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned))

  if (!open) return null
  return (
    <div className="notes-dropdown" ref={ref} role="dialog" aria-label="ReyDesk notes">
      <div className="notes-dropdown-header">
        {view !== 'all' ? (
          <button type="button" className="notes-dropdown-back" onClick={() => setView('all')} aria-label="Back to all notes"><Icon name="chevron-left" size={15} />Notes</button>
        ) : (
          <button type="button" className="notes-dropdown-add" onClick={() => void handleCreate()} disabled={saving} title="New note" aria-label="New note"><Icon name="add" size={15} /></button>
        )}
        <div className="notes-dropdown-heading"><h4 className="notes-dropdown-title">{view === 'categories' ? 'Categories' : view === 'note' ? 'Note' : 'Notes'}</h4><span className="notes-dropdown-count">{notes.length}</span></div>
        {view === 'all' ? <>
          <button type="button" className="notes-dropdown-icon" onClick={() => setSearchOpen((value) => !value)} title="Search notes" aria-label="Search notes"><Icon name="search" size={15} /></button>
          <button type="button" className="notes-dropdown-categories" onClick={() => setView('categories')} title="Manage categories"><Icon name="folder" size={14} /><span>Categories</span></button>
        </> : null}
        <button type="button" className="notes-dropdown-close" onClick={onClose} title="Close notes" aria-label="Close notes"><Icon name="close" size={15} /></button>
      </div>

      {error ? <div className="notes-inline-error" role="alert">{error}</div> : null}

      {view === 'all' ? <>
        {searchOpen ? <div className="notes-dropdown-search"><Icon name="search" size={15} /><input ref={searchRef} className="notes-dropdown-search-input" placeholder="Search notes…" value={search} onChange={(event) => setSearch(event.target.value)} /></div> : null}
        {categories.length > 0 ? <div className="notes-category-filter" aria-label="Filter by category">{categories.map((category) => <button type="button" key={category.id} className={categoryFilter === category.id ? 'active' : ''} onClick={() => setCategoryFilter((value) => value === category.id ? '' : category.id)}><span style={{ background: getColorStyle(category.color).border }} />{category.name}</button>)}</div> : null}
        <div className="notes-dropdown-grid">
          {loading ? <div className="notes-dropdown-empty">Loading notes…</div> : filtered.length === 0 ? <div className="notes-dropdown-empty"><strong>{search ? 'No notes found' : 'No notes yet'}</strong><span>Use + to create one.</span></div> : filtered.map((note) => {
            const color = getColorStyle(note.color)
            return <article key={note.id} className={`notes-card${note.is_pinned ? ' is-pinned' : ''}`} style={{ background: color.bg, color: color.text, borderColor: color.border }}>
              <button type="button" className="notes-card-content" onClick={() => openNote(note)}>
                <div className="notes-card-header"><span className="notes-card-category">{note.category_name || 'Note'}</span>{note.is_pinned ? <Icon name="pin" size={12} /> : null}</div>
                <span className="notes-card-body">{note.body || <span className="notes-card-empty">Empty note</span>}</span>
                {(note.images ?? []).length > 0 ? (
                  <div className="notes-card-thumbs">
                    {(note.images ?? []).slice(0, 3).map((src, index) => <img key={index} src={src} alt="" />)}
                    {(note.images ?? []).length > 3 ? <span className="notes-card-thumbs-more">+{(note.images ?? []).length - 3}</span> : null}
                  </div>
                ) : null}
              </button>
              <div className="notes-card-footer"><span className="notes-card-date">{new Date(note.updated_at || note.created_at).toLocaleDateString()}</span><div className="notes-card-actions"><button type="button" className="notes-card-action" onClick={() => void togglePin(note)} title={note.is_pinned ? 'Unpin note' : 'Pin note'} aria-label={note.is_pinned ? 'Unpin note' : 'Pin note'}><Icon name="pin" size={13} /></button><button type="button" className="notes-card-action notes-card-delete" onClick={() => void removeNote(note.id)} title="Delete note" aria-label="Delete note"><Icon name="delete" size={13} /></button></div></div>
            </article>
          })}
        </div>
      </> : view === 'categories' ? <div className="notes-category-view"><div className="notes-category-create"><input className="field-input" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void addCategory() } }} placeholder="Category name" aria-label="Category name" /><div className="notes-color-picker">{NOTE_COLORS.map((color) => <button type="button" key={color.name} className={categoryColor === color.name ? 'active' : ''} style={{ background: color.border }} onClick={() => setCategoryColor(color.name)} aria-label={`Use ${color.name} category`} />)}</div><button type="button" className="btn btn-primary btn-sm" onClick={() => void addCategory()} disabled={!categoryName.trim() || creatingCategory}><Icon name="add" size={13} />Create</button></div>{categories.length === 0 ? <div className="notes-dropdown-empty">No categories yet.</div> : <div className="notes-category-list">{categories.map((category) => <div key={category.id} className="notes-category-row"><span className="notes-category-swatch" style={{ background: getColorStyle(category.color).border }} /><strong>{category.name}</strong><button type="button" className="notes-card-action notes-card-delete" onClick={() => void deleteNoteCategory(category.id).then(() => setCategories((items) => items.filter((item) => item.id !== category.id))).catch(() => setError('The category could not be deleted.'))} title="Delete category" aria-label={`Delete ${category.name}`}><Icon name="delete" size={13} /></button></div>)}</div>}</div> : <div className="notes-editor-view" style={{ background: getColorStyle(draft.color).bg, color: getColorStyle(draft.color).text }}><label className="field-label">Category<select className="field-input" value={draft.category_id} onChange={(event) => persist({ category_id: event.target.value })}><option value="">No category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><label className="field-label notes-editor-body-label">Note<div ref={editorRef} className="notes-editor-rich" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Note content" data-placeholder="Write something…" onInput={handleEditorInput} onKeyDown={handleEditorKeyDown} /></label><div className="notes-editor-footer"><div className="notes-color-picker" aria-label="Note background"><span className="notes-footer-label">Color</span>{NOTE_COLORS.map((color) => <button type="button" key={color.name} className={draft.color === color.name ? 'active' : ''} style={{ background: color.border }} onClick={() => persist({ color: color.name })} aria-label={`Use ${color.name} note background`} />)}</div><label className="notes-image-upload"><Icon name="upload" size={14} />Image<input type="file" accept="image/*" multiple hidden onChange={(event) => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length > 0) void addImages(files) }} /></label><span className="notes-save-state">{saving ? 'Saving…' : 'Saved automatically'}</span><button type="button" className="notes-card-action notes-card-delete" onClick={() => selected && void removeNote(selected.id)} title="Delete note" aria-label="Delete note"><Icon name="delete" size={14} /></button></div></div>}
    </div>
  )
}
