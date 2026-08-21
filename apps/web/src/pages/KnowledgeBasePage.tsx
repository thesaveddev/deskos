import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { Shell } from '../components/Shell.js'
import { Icon } from '../components/Icons.js'
import { Alert, Field, Modal, PageHeader, Panel, useConfirm } from '../components/ui.js'
import { Pagination } from '../components/Pagination.js'
import { useAuth } from '../lib/auth.js'
import {
  createArticle, createFolder, createRelation, deleteFolder, deleteRelation, getArticle, getKbOverview,
  listArticles, listFolders, setArticleStatus, updateArticle, updateFolder,
  type KbArticle, type KbFolder, type KbOverview, type KbRelation, type KbRelationType, type KbStatus, type KbVisibility,
} from '../lib/kb.js'

const STATUSES: KbStatus[] = ['draft', 'review', 'published', 'archived']
const VISIBILITIES: KbVisibility[] = ['internal', 'portal', 'public']
const STATUS_LABELS: Record<KbStatus, string> = { draft: 'Draft', review: 'In review', published: 'Published', archived: 'Archived' }
const RELATION_LABELS: Record<KbRelationType, string> = { related: 'Related', prerequisite: 'Prerequisite', follow_up: 'Follow-up' }

interface FormState {
  title: string
  summary: string
  body: string
  folderId: string
  visibility: KbVisibility
  status: KbStatus
  tags: string
  reviewDueAt: string
}

const EMPTY_FORM: FormState = { title: '', summary: '', body: '', folderId: '', visibility: 'internal', status: 'draft', tags: '', reviewDueAt: '' }

function formatDate(value?: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value))
}

function articleExcerpt(article: KbArticle): string {
  return article.summary || article.body.replace(/[#*`]/g, '').slice(0, 180)
}

function ArticleBody({ body }: { body: string }) {
  return (
    <div className="kb-rendered-body">
      {body.split('\n').map((line, index) => {
        const key = `${index}-${line.slice(0, 12)}`
        if (line.startsWith('### ')) return <h4 key={key}>{line.slice(4)}</h4>
        if (line.startsWith('## ')) return <h3 key={key}>{line.slice(3)}</h3>
        if (line.startsWith('# ')) return <h2 key={key}>{line.slice(2)}</h2>
        if (/^[-*] /.test(line)) return <li key={key}>{line.slice(2)}</li>
        if (!line.trim()) return <div key={key} className="kb-body-space" />
        return <p key={key}>{line}</p>
      })}
    </div>
  )
}

export default function KnowledgeBasePage() {
  const auth = useAuth()
  const permissions = new Set(auth.memberships.flatMap((m) => m.permissions))
  const canWrite = permissions.has('kb.write')
  const confirm = useConfirm()
  const [articles, setArticles] = useState<KbArticle[]>([])
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [folders, setFolders] = useState<KbFolder[]>([])
  const [overview, setOverview] = useState<KbOverview | null>(null)
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const [statusFilter, setStatusFilter] = useState<KbStatus | ''>('')
  const [visibilityFilter, setVisibilityFilter] = useState<KbVisibility | ''>('')
  const [folderFilter, setFolderFilter] = useState('')
  const [sort, setSort] = useState<'updated' | 'views' | 'helpful' | 'review_due' | 'title'>('updated')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [editing, setEditing] = useState<KbArticle | null>(null)
  const [viewing, setViewing] = useState<{ article: KbArticle; versions: Array<{ version: number; title: string; summary: string; author_id: string; created_at: string }>; relations: KbRelation[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [showFolderForm, setShowFolderForm] = useState(false)
  const [editingFolder, setEditingFolder] = useState<KbFolder | null>(null)
  const [newFolder, setNewFolder] = useState({ name: '', parentId: '', visibility: 'internal' as KbVisibility })
  const [modalError, setModalError] = useState<string | null>(null)
  const [editorTab, setEditorTab] = useState<'write' | 'preview'>('write')
  const [relatedId, setRelatedId] = useState('')
  const [relatedType, setRelatedType] = useState<KbRelationType>('related')

  const folderName = useCallback((id: string | null) => folders.find((folder) => folder.id === id)?.name ?? 'Unfiled', [folders])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [result, folderResult, overviewResult] = await Promise.all([
        listArticles({ q: q.trim() || undefined, tag: tag.trim() || undefined, status: statusFilter || undefined, visibility: visibilityFilter || undefined, folderId: folderFilter || undefined, sort, page: pagination.page, pageSize: pagination.pageSize }),
        listFolders(),
        getKbOverview(),
      ])
      setArticles(result.articles)
      setPagination(result.pagination)
      setFolders(folderResult.folders)
      setOverview(overviewResult)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the knowledge base')
    } finally {
      setLoading(false)
    }
  }, [folderFilter, pagination.page, pagination.pageSize, q, sort, statusFilter, tag, visibilityFilter])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), q || tag ? 250 : 0)
    return () => window.clearTimeout(timer)
  }, [load, q, tag])

  const resetListPage = () => setPagination((current) => ({ ...current, page: 1 }))

  function startNew() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setModalError(null)
    setEditorTab('write')
    setShowForm(true)
  }

  function openNewFolder() {
    setEditingFolder(null)
    setNewFolder({ name: '', parentId: '', visibility: 'internal' })
    setModalError(null)
    setShowFolderForm(true)
  }

  function startEditFolder(folder: KbFolder) {
    setEditingFolder(folder)
    setNewFolder({ name: folder.name, parentId: folder.parent_id ?? '', visibility: folder.visibility })
    setModalError(null)
    setShowFolderForm(true)
  }

  function closeFolderForm(force = false) {
    if (busy && !force) return
    setShowFolderForm(false)
    setEditingFolder(null)
    setNewFolder({ name: '', parentId: '', visibility: 'internal' })
    setModalError(null)
  }

  function startEdit(article: KbArticle) {
    setEditing(article)
    setForm({
      title: article.title,
      summary: article.summary ?? '',
      body: article.body,
      folderId: article.folder_id ?? '',
      visibility: article.visibility,
      status: article.status,
      tags: (article.tags ?? []).join(', '),
      reviewDueAt: article.review_due_at ? article.review_due_at.slice(0, 16) : '',
    })
    setEditorTab('write')
    setModalError(null)
    setViewing(null)
    setShowForm(true)
  }

  async function openArticle(id: string) {
    setError(null)
    try {
      setViewing((await getArticle(id)) as NonNullable<typeof viewing>)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open article')
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (busy || !canWrite) return
    setBusy(true); setError(null); setModalError(null); setNotice(null)
    try {
      const body = {
        title: form.title.trim(), summary: form.summary.trim(), body: form.body,
        folderId: form.folderId || null, visibility: form.visibility, tags: form.tags.split(',').map((value) => value.trim()).filter(Boolean),
        reviewDueAt: form.reviewDueAt ? new Date(form.reviewDueAt).toISOString() : null,
        ...(editing ? {} : { status: form.status }),
      }
      if (editing) await updateArticle(editing.id, body)
      else await createArticle(body)
      setShowForm(false); setEditing(null); setForm(EMPTY_FORM); setModalError(null); setNotice(editing ? 'Article updated.' : 'Article created.')
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not save article'
      setError(message)
      setModalError(message)
    } finally { setBusy(false) }
  }

  async function changeStatus(article: KbArticle, status: KbStatus) {
    if (!canWrite || busy) return
    setBusy(true); setError(null); setNotice(null)
    try { await setArticleStatus(article.id, status); setNotice(`Article moved to ${STATUS_LABELS[status].toLowerCase()}.`); await openArticle(article.id); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update article status') }
    finally { setBusy(false) }
  }

  async function handleFolder(event: FormEvent) {
    event.preventDefault()
    if (!newFolder.name.trim() || busy || !canWrite) return
    setBusy(true); setError(null); setModalError(null)
    try {
      if (editingFolder) {
        await updateFolder(editingFolder.id, { name: newFolder.name.trim(), parentId: newFolder.parentId || null, visibility: newFolder.visibility })
        setNotice('Folder updated.')
      } else {
        await createFolder({ name: newFolder.name.trim(), parentId: newFolder.parentId || null, visibility: newFolder.visibility })
        setNotice('Folder created.')
      }
      closeFolderForm(true)
      await load()
    } catch (err) {
      const message = err instanceof Error ? err.message : editingFolder ? 'Could not update folder' : 'Could not create folder'
      setError(message)
      setModalError(message)
    } finally { setBusy(false) }
  }

  async function removeFolder(folder: KbFolder) {
    if (!canWrite || busy || !await confirm(`Delete “${folder.name}”? Articles will become unfiled.`, { title: 'Delete knowledge base folder', confirmLabel: 'Delete folder', destructive: true })) return
    setBusy(true); setError(null)
    try { await deleteFolder(folder.id); setNotice('Folder deleted.'); await load() }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not delete folder') }
    finally { setBusy(false) }
  }

  async function addRelation(event: FormEvent) {
    event.preventDefault()
    if (!viewing || !relatedId || !canWrite || busy) return
    setBusy(true); setError(null)
    try { await createRelation(viewing.article.id, { relatedArticleId: relatedId, relationType: relatedType }); setRelatedId(''); setNotice('Related article added.'); await openArticle(viewing.article.id) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not relate article') }
    finally { setBusy(false) }
  }

  async function removeRelation(relation: KbRelation) {
    if (!viewing || !relation.id || !canWrite || busy) return
    setBusy(true); setError(null)
    try { await deleteRelation(viewing.article.id, relation.id); await openArticle(viewing.article.id) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not remove relation') }
    finally { setBusy(false) }
  }

  const selectableRelated = useMemo(() => articles.filter((article) => article.id !== viewing?.article.id), [articles, viewing?.article.id])

  return (
    <Shell>
      <PageHeader
        title="Knowledge base"
        subtitle="Turn proven fixes into reusable answers, keep them current, and measure whether they actually help people."
        actions={canWrite ? <div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={openNewFolder}><Icon name="folder" size={14} />New folder</button><button className="btn btn-primary btn-sm" onClick={startNew}><Icon name="add" size={14} />New article</button></div> : undefined}
      />

      {error ? <Alert kind="error">{error}</Alert> : null}
      {notice ? <Alert kind="info">{notice}</Alert> : null}

      {overview ? (
        <div className="kb-overview-grid">
          <div className="stat-card"><span className="stat-value mono">{overview.summary.published}</span><span className="stat-label">Published articles</span><span className="stat-hint">{overview.summary.total} total</span></div>
          <div className="stat-card"><span className="stat-value mono">{overview.summary.overdue}</span><span className="stat-label">Due for review</span><span className="stat-hint">Keep advice trustworthy</span></div>
          <div className="stat-card"><span className="stat-value mono">{overview.summary.views}</span><span className="stat-label">Article views</span><span className="stat-hint">Portal and internal reads</span></div>
          <div className="stat-card"><span className="stat-value mono">{overview.summary.helpful + overview.summary.not_helpful === 0 ? '—' : `${Math.round((overview.summary.helpful / (overview.summary.helpful + overview.summary.not_helpful)) * 100)}%`}</span><span className="stat-label">Helpful rate</span><span className="stat-hint">Based on requester feedback</span></div>
        </div>
      ) : null}

      <div className="kb-workspace">
        <aside className="kb-sidebar">
          <Panel title="Library" subtitle={`${folders.length} folders`} actions={canWrite ? <button className="icon-btn" onClick={openNewFolder} aria-label="Add folder"><Icon name="add" size={14} /></button> : undefined}>
            <button className={`kb-folder-row${folderFilter === '' ? ' active' : ''}`} onClick={() => { setFolderFilter(''); resetListPage() }}><Icon name="file" size={15} />All articles <span>{overview?.summary.total ?? '—'}</span></button>
            {folders.map((folder) => <div className="kb-folder-row-wrap" key={folder.id}><button className={`kb-folder-row${folderFilter === folder.id ? ' active' : ''}`} onClick={() => { setFolderFilter(folder.id); resetListPage() }}><Icon name="folder" size={15} />{folder.name}<span>{folder.article_count ?? 0}</span></button>{canWrite ? <div className="kb-folder-actions"><button className="icon-btn kb-folder-edit" onClick={() => startEditFolder(folder)} aria-label={`Edit ${folder.name}`}><Icon name="edit" size={13} /></button><button className="icon-btn kb-folder-delete" onClick={() => void removeFolder(folder)} aria-label={`Delete ${folder.name}`}><Icon name="delete" size={13} /></button></div> : null}</div>)}
          </Panel>
          {overview?.overdueArticles.length ? <Panel title="Needs review" subtitle="Published guidance past its review date"><div className="kb-review-list">{overview.overdueArticles.map((article) => <button key={article.id} className="kb-review-item" onClick={() => void openArticle(article.id)}><strong>{article.title}</strong><small>Review due {formatDate(article.review_due_at)}</small></button>)}</div></Panel> : null}
        </aside>

        <section className="kb-main">
          {viewing ? (
            <Panel actions={<div className="page-actions"><button className="btn btn-ghost btn-sm" onClick={() => setViewing(null)}><Icon name="back" size={14} />Back to library</button>{canWrite ? <button className="btn btn-primary btn-sm" onClick={() => startEdit(viewing.article)}><Icon name="edit" size={14} />Edit article</button> : null}</div>}>
              <div className="kb-detail-head"><div><span className={`kb-status kb-status-${viewing.article.status}`}>{STATUS_LABELS[viewing.article.status]}</span><span className="kb-detail-folder">{folderName(viewing.article.folder_id)} · v{viewing.article.version}</span><h2>{viewing.article.title}</h2><p className="kb-detail-summary">{viewing.article.summary || 'No summary provided.'}</p></div></div>
              <div className="kb-detail-meta"><span><Icon name="eye" size={14} />{viewing.article.view_count} views</span><span><Icon name="check" size={14} />{viewing.article.helpful_count} helpful</span><span>Visibility: {viewing.article.visibility}</span><span>Updated {formatDate(viewing.article.updated_at)}</span>{viewing.article.review_due_at ? <span>Review {formatDate(viewing.article.review_due_at)}</span> : null}</div>
              <ArticleBody body={viewing.article.body} />
              {canWrite ? <div className="kb-detail-actions"><button className="btn btn-ghost btn-sm" onClick={() => void changeStatus(viewing.article, viewing.article.status === 'published' ? 'archived' : 'published')}><Icon name={viewing.article.status === 'published' ? 'folder' : 'check'} size={14} />{viewing.article.status === 'published' ? 'Archive' : 'Publish'}</button></div> : null}
              <div className="kb-detail-grid">
                <section className="kb-detail-section"><h3>Version history</h3>{viewing.versions.map((version) => <div className="kb-version-row" key={version.version}><span className="mono">v{version.version}</span><span>{version.title}</span><small>{formatDate(version.created_at)}</small></div>)}</section>
                <section className="kb-detail-section"><h3>Related guidance</h3>{viewing.relations.map((relation) => <div className="kb-related-row" key={relation.id ?? relation.related_article_id}><button onClick={() => void openArticle(relation.related_article_id)}><strong>{relation.related_title}</strong><small>{RELATION_LABELS[relation.relation_type]}</small></button>{canWrite && relation.id ? <button className="icon-btn" onClick={() => void removeRelation(relation)} aria-label="Remove related article"><Icon name="delete" size={13} /></button> : null}</div>)}{canWrite ? <form className="kb-relation-form" onSubmit={addRelation}><select className="field-input" value={relatedId} onChange={(event) => setRelatedId(event.target.value)}><option value="">Add an article…</option>{selectableRelated.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select><select className="field-input" value={relatedType} onChange={(event) => setRelatedType(event.target.value as KbRelationType)}><option value="related">Related</option><option value="prerequisite">Prerequisite</option><option value="follow_up">Follow-up</option></select><button className="btn btn-ghost btn-sm" disabled={!relatedId || busy}><Icon name="add" size={14} />Add</button></form> : null}</section>
              </div>
            </Panel>
          ) : (
            <Panel title="Articles" subtitle={loading ? 'Refreshing library…' : `${pagination.total} article${pagination.total === 1 ? '' : 's'}`} actions={<button className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading}><Icon name="refresh" size={14} />Refresh</button>} toolbar={<div className="kb-filter-bar"><div className="kb-search"><Icon name="search" size={15} /><input className="field-input" value={q} onChange={(event) => { setQ(event.target.value); resetListPage() }} placeholder="Search titles, summaries, and content…" aria-label="Search knowledge base" /></div><select className="field-input" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as KbStatus | ''); resetListPage() }}><option value="">All statuses</option>{STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select><select className="field-input" value={visibilityFilter} onChange={(event) => { setVisibilityFilter(event.target.value as KbVisibility | ''); resetListPage() }}><option value="">All audiences</option>{VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{visibility}</option>)}</select><input className="field-input kb-tag-filter" value={tag} onChange={(event) => { setTag(event.target.value); resetListPage() }} placeholder="Tag" /><select className="field-input" value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}><option value="updated">Recently updated</option><option value="views">Most viewed</option><option value="helpful">Most helpful</option><option value="review_due">Review due</option><option value="title">Title A–Z</option></select></div>}>
              {articles.length === 0 && !loading ? <div className="empty-state"><Icon name="file" size={28} /><h3>No articles found</h3><p>Try a different filter or create the first piece of guidance for your team.</p>{canWrite ? <button className="btn btn-primary" onClick={startNew}><Icon name="add" size={14} />Create article</button> : null}</div> : <div className="kb-article-list">{articles.map((article) => <article className="kb-article-card" key={article.id}><button className="kb-article-card-main" onClick={() => void openArticle(article.id)}><div className="kb-article-card-title"><span className={`kb-status kb-status-${article.status}`}>{STATUS_LABELS[article.status]}</span><h3>{article.title}</h3></div><p>{articleExcerpt(article)}</p><div className="kb-card-meta"><span>{folderName(article.folder_id)}</span><span>{article.visibility}</span><span>v{article.version}</span><span>{article.view_count} views</span>{article.review_due_at ? <span>Review {formatDate(article.review_due_at)}</span> : null}</div></button><div className="kb-card-actions">{canWrite ? <button className="btn btn-ghost btn-sm" onClick={() => startEdit(article)}><Icon name="edit" size={14} />Edit</button> : null}{canWrite ? <button className="btn btn-ghost btn-sm" onClick={() => void changeStatus(article, article.status === 'published' ? 'archived' : 'published')}><Icon name={article.status === 'published' ? 'folder' : 'check'} size={14} />{article.status === 'published' ? 'Archive' : 'Publish'}</button> : null}</div></article>)}</div>}
              <Pagination page={Math.max(0, pagination.page - 1)} pageSize={pagination.pageSize} totalItems={pagination.total} loading={loading} onPageChange={(page) => setPagination((current) => ({ ...current, page: page + 1 }))} onPageSizeChange={(pageSize) => setPagination((current) => ({ ...current, page: 1, pageSize }))} />
            </Panel>
          )}
        </section>
      </div>

      <Modal open={showFolderForm} onClose={closeFolderForm} title={editingFolder ? 'Edit folder' : 'Create folder'} width={440}>
        <form onSubmit={handleFolder}>
          {modalError ? <Alert kind="error">{modalError}</Alert> : null}
          <Field label="Folder name"><input className="field-input" value={newFolder.name} onChange={(event) => { setModalError(null); setNewFolder({ ...newFolder, name: event.target.value }) }} placeholder="e.g. Microsoft 365" maxLength={120} autoFocus required /></Field>
          <Field label="Parent folder"><select className="field-input" value={newFolder.parentId} onChange={(event) => setNewFolder({ ...newFolder, parentId: event.target.value })}><option value="">Top level</option>{folders.filter((folder) => folder.id !== editingFolder?.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
          <Field label="Audience"><select className="field-input" value={newFolder.visibility} onChange={(event) => setNewFolder({ ...newFolder, visibility: event.target.value as KbVisibility })}><option value="internal">Internal team</option><option value="portal">Customer portal</option><option value="public">Public</option></select></Field>
          <div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => closeFolderForm()} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}><Icon name="save" size={14} />{busy ? 'Saving…' : editingFolder ? 'Save changes' : 'Create folder'}</button></div>
        </form>
      </Modal>

      <Modal open={showForm} onClose={() => { if (!busy) { setShowForm(false); setModalError(null) } }} title={editing ? 'Edit article' : 'Create knowledge article'} width={760}>
        <form onSubmit={handleSubmit} className="kb-editor-form">{modalError ? <Alert kind="error">{modalError}</Alert> : null}<div className="kb-editor-tabs"><button type="button" className={editorTab === 'write' ? 'active' : ''} onClick={() => setEditorTab('write')}>Write</button><button type="button" className={editorTab === 'preview' ? 'active' : ''} onClick={() => setEditorTab('preview')}>Preview</button></div>{editorTab === 'write' ? <><Field label="Title"><input className="field-input" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} maxLength={300} required autoFocus /></Field><Field label="Summary" hint="Shown in search results and portal cards"><textarea className="field-input" rows={2} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} maxLength={600} placeholder="A clear one or two sentence answer…" /></Field><Field label="Body" hint="Supports headings (#), bullets (-), and plain text"><textarea className="field-input kb-editor-body" rows={16} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} maxLength={200000} placeholder="# Resolution\n\nDescribe the symptom, cause, and steps to fix it." /></Field><div className="form-row"><Field label="Folder"><select className="field-input" value={form.folderId} onChange={(event) => setForm({ ...form, folderId: event.target.value })}><option value="">Unfiled</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><Field label="Audience"><select className="field-input" value={form.visibility} onChange={(event) => setForm({ ...form, visibility: event.target.value as KbVisibility })}>{VISIBILITIES.map((visibility) => <option key={visibility} value={visibility}>{visibility}</option>)}</select></Field></div><div className="form-row"><Field label="Tags" hint="comma-separated"><input className="field-input" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} placeholder="vpn, windows, password" /></Field><Field label="Review date" hint="Optional freshness reminder"><input className="field-input" type="datetime-local" value={form.reviewDueAt} onChange={(event) => setForm({ ...form, reviewDueAt: event.target.value })} /></Field></div>{!editing ? <Field label="Initial status"><select className="field-input" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as KbStatus })}>{STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}</option>)}</select></Field> : null}</> : <div className="kb-editor-preview"><h2>{form.title || 'Untitled article'}</h2><p className="kb-detail-summary">{form.summary || 'No summary yet.'}</p><ArticleBody body={form.body || 'Start writing to preview this article.'} /></div>}<div className="form-actions"><button type="button" className="btn btn-ghost" onClick={() => { setShowForm(false); setModalError(null) }} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}><Icon name="save" size={14} />{busy ? 'Saving…' : editing ? 'Save changes' : 'Create article'}</button></div></form>
      </Modal>
    </Shell>
  )
}
