import { useCallback, useEffect, useState } from 'react'
import { Shell } from '../components/Shell.js'
import { Alert, Field } from '../components/ui.js'
import {
  createArticle, createFolder, getArticle, listArticles, listFolders, setArticleStatus, updateArticle,
  type KbArticle, type KbFolder, type KbStatus, type KbVisibility,
} from '../lib/kb.js'

const STATUSES: KbStatus[] = ['draft', 'review', 'published', 'archived']
const VISIBILITIES: KbVisibility[] = ['internal', 'portal', 'public']
const STATUS_LABELS: Record<KbStatus, string> = {
  draft: 'Draft',
  review: 'In review',
  published: 'Published',
  archived: 'Archived',
}

interface FormState {
  title: string
  body: string
  folderId: string
  visibility: KbVisibility
  status: KbStatus
  tags: string
}

const EMPTY_FORM: FormState = {
  title: '',
  body: '',
  folderId: '',
  visibility: 'internal',
  status: 'draft',
  tags: '',
}

export default function KnowledgeBasePage() {
  const [articles, setArticles] = useState<KbArticle[] | null>(null)
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [q, setQ] = useState('')
  const [statusFilter, setStatusFilter] = useState<KbStatus | ''>('')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<KbArticle | null>(null)
  const [viewing, setViewing] = useState<KbArticle | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [newFolder, setNewFolder] = useState('')

  const load = useCallback(async () => {
    try {
      const [a, f] = await Promise.all([
        listArticles({ q: q || undefined, status: statusFilter || undefined }),
        listFolders(),
      ])
      setArticles(a.articles)
      setFolders(f.folders)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load articles')
    }
  }, [q, statusFilter])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250)
    return () => clearTimeout(timer)
  }, [load])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean)
    try {
      const body = {
        title: form.title,
        body: form.body,
        folderId: form.folderId || undefined,
        visibility: form.visibility,
        tags,
        ...(editing ? {} : { status: form.status }),
      }
      if (editing) {
        await updateArticle(editing.id, body)
        setNotice('Article updated.')
      } else {
        await createArticle(body)
        setNotice('Article created.')
      }
      setForm(EMPTY_FORM)
      setEditing(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  async function handleStatus(article: KbArticle, status: KbStatus) {
    setError(null)
    setNotice(null)
    try {
      await setArticleStatus(article.id, status)
      setNotice(`Article ${status}.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed')
    }
  }

  async function handleAddFolder(e: React.FormEvent) {
    e.preventDefault()
    if (!newFolder.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await createFolder({ name: newFolder.trim() })
      setNewFolder('')
      setNotice('Folder created.')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Folder creation failed')
    } finally {
      setBusy(false)
    }
  }

  function startEdit(article: KbArticle) {
    setEditing(article)
    setViewing(null)
    setForm({
      title: article.title,
      body: article.body,
      folderId: article.folder_id ?? '',
      visibility: article.visibility,
      status: article.status,
      tags: (article.tags ?? []).join(', '),
    })
    setError(null)
  }

  async function openArticle(id: string) {
    setError(null)
    try {
      const { article } = await getArticle(id)
      setViewing(article)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open article')
    }
  }

  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name ?? '—'

  return (
    <Shell>
      <div className="page-head">
        <h1 className="page-title">Knowledge base</h1>
      </div>

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      <div className="kb-layout">
        <section className="form-panel">
          <h2 className="channel-form-title">{editing ? 'Edit article' : 'New article'}</h2>
          <form onSubmit={handleSubmit} className="channel-form">
            <Field label="Title">
              <input
                className="field-input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                minLength={1}
                maxLength={300}
                required
              />
            </Field>
            <Field label="Body" hint="Plain text / markdown">
              <textarea
                className="field-input"
                rows={10}
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                maxLength={200000}
              />
            </Field>
            <div className="form-row">
              <Field label="Folder">
                <select
                  className="field-input"
                  value={form.folderId}
                  onChange={(e) => setForm({ ...form, folderId: e.target.value })}
                >
                  <option value="">— none —</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Visibility">
                <select
                  className="field-input"
                  value={form.visibility}
                  onChange={(e) => setForm({ ...form, visibility: e.target.value as KbVisibility })}
                >
                  {VISIBILITIES.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </Field>
            </div>
            <div className="form-row">
              {!editing ? (
                <Field label="Status">
                  <select
                    className="field-input"
                    value={form.status}
                    onChange={(e) => setForm({ ...form, status: e.target.value as KbStatus })}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                  </select>
                </Field>
              ) : null}
              <Field label="Tags" hint="comma-separated">
                <input
                  className="field-input mono"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="vpn, password"
                />
              </Field>
            </div>
            <div className="form-actions">
              {editing ? (
                <button type="button" className="btn btn-ghost" onClick={() => { setEditing(null); setForm(EMPTY_FORM) }}>
                  Cancel edit
                </button>
              ) : null}
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create article'}
              </button>
            </div>
          </form>

          <h3 className="channel-title" style={{ marginTop: 28 }}>Folders</h3>
          <form onSubmit={handleAddFolder} className="channel-form">
            <div className="form-row">
              <Field label="New folder">
                <input
                  className="field-input"
                  value={newFolder}
                  onChange={(e) => setNewFolder(e.target.value)}
                  placeholder="e.g. How-to guides"
                  maxLength={120}
                />
              </Field>
            </div>
            <div className="form-actions">
              <button type="submit" className="btn btn-ghost" disabled={busy || !newFolder.trim()}>Add folder</button>
            </div>
          </form>
          {folders.length === 0 ? (
            <p className="muted">No folders yet.</p>
          ) : (
            <ul className="channel-list">
              {folders.map((f) => (
                <li key={f.id} className="channel-card">
                  <span className="channel-name">{f.name}</span>
                  <span className="channel-meta mono">{f.visibility}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="form-panel">
          <div className="kb-toolbar">
            <input
              className="field-input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search articles…"
              aria-label="Search articles"
            />
            <select
              className="field-input"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as KbStatus | '')}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>

          {viewing ? (
            <div className="kb-article-view">
              <div className="kb-article-view-head">
                <button className="btn btn-ghost btn-sm" onClick={() => setViewing(null)}>← Back</button>
                <button className="btn btn-ghost btn-sm" onClick={() => startEdit(viewing)}>Edit</button>
              </div>
              <h2 className="channel-form-title">{viewing.title}</h2>
              <p className="muted">
                v{viewing.version} · {STATUS_LABELS[viewing.status] ?? viewing.status} · {viewing.visibility} · {folderName(viewing.folder_id)}
              </p>
              <div className="kb-body">{viewing.body || <em className="muted">No body.</em>}</div>
              <div className="kb-actions">
                {viewing.status !== 'published' ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => void handleStatus(viewing, 'published')}>Publish</button>
                ) : null}
                {viewing.status !== 'archived' ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => void handleStatus(viewing, 'archived')}>Archive</button>
                ) : null}
                {viewing.status === 'archived' ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => void handleStatus(viewing, 'draft')}>Restore to draft</button>
                ) : null}
              </div>
            </div>
          ) : articles === null ? (
            <span className="etch">Loading articles…</span>
          ) : articles.length === 0 ? (
            <p className="muted">No articles match.</p>
          ) : (
            <ul className="channel-list">
              {articles.map((a) => (
                <li key={a.id} className="channel-card">
                  <div className="channel-main">
                    <span className="channel-name">{a.title}</span>
                    <span className="channel-meta mono">
                      v{a.version} · {STATUS_LABELS[a.status] ?? a.status} · {a.visibility}
                      {a.folder_id ? ` · ${folderName(a.folder_id)}` : ''}
                    </span>
                    <p className="muted" style={{ marginTop: 6 }}>
                      {a.body.slice(0, 140)}{a.body.length > 140 ? '…' : ''}
                    </p>
                  </div>
                  <div className="channel-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => void openArticle(a.id)}>View</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => startEdit(a)}>Edit</button>
                    {a.status !== 'published' ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => void handleStatus(a, 'published')}>Publish</button>
                    ) : (
                      <button className="btn btn-ghost btn-sm" onClick={() => void handleStatus(a, 'archived')}>Archive</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Shell>
  )
}
