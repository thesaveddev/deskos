import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons.js'
import { searchDirectory, type DirectoryPerson } from '../lib/directory.js'

export function DirectoryPersonPicker({
  onSelect,
  placeholder = 'Search directory by name, email, or staff ID…',
}: {
  onSelect: (person: DirectoryPerson) => void
  placeholder?: string
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<DirectoryPerson[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<number | undefined>(undefined)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setOpen(false)
      setError(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setError(null)
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      searchDirectory(q)
        .then((res) => {
          setResults(res.contacts)
          setOpen(true)
        })
        .catch((err) => {
          setResults([])
          setError(err instanceof Error ? err.message : 'Directory search failed')
          setOpen(true)
        })
        .finally(() => setSearching(false))
    }, 250)
    return () => window.clearTimeout(debounceRef.current)
  }, [query])

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const choose = (person: DirectoryPerson) => {
    onSelect(person)
    setQuery('')
    setResults([])
    setOpen(false)
  }

  return (
    <div className="directory-picker" ref={wrapRef}>
      <div className="directory-picker-input-wrap">
        <span className="directory-search-icon"><Icon name="search" size={14} /></span>
        <input
          className="field-input"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => { if (results.length || error) setOpen(true) }}
          placeholder={placeholder}
          autoComplete="off"
        />
      </div>
      {open && (
        <div className="directory-picker-results">
          {searching && <div className="directory-picker-state">Searching…</div>}
          {error && <div className="directory-picker-state directory-picker-error">{error}</div>}
          {!searching && !error && results.length === 0 && <div className="directory-picker-state">No directory matches</div>}
          {!searching && !error && results.map((person) => (
            <button type="button" key={person.id} className="directory-picker-item" onClick={() => choose(person)}>
              <span className="directory-picker-avatar"><Icon name="user" size={14} /></span>
              <span className="directory-picker-main">
                <strong>{person.name}</strong>
                <small>{person.email}{person.staffId ? ` · ${person.staffId}` : ''}</small>
              </span>
              <span className="directory-picker-dept">{person.department ?? ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
