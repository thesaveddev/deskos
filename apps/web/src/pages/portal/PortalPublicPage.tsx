import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router-dom'
import { BrandRow } from '../../components/ui.js'
import { Icon } from '../../components/Icons.js'
import { formatWhen } from '../../lib/tickets.js'
import { portalKbCategories, type PortalKbCategory } from '../../lib/portal.js'

interface PortalMeta {
  name: string
  slug: string
  branding: { portalTitle?: string | null; logoUrl?: string | null; primaryColor?: string | null }
  portalEnabled: boolean
  allowPublicKb: boolean
}

interface PublicArticle {
  id: string
  title: string
  summary: string
  body?: string
  folder_id?: string | null
  tags: string[] | null
  updated_at: string
}

/** Public tenant portal page, shared as reydesk.com/portal/<slug>. */
export default function PortalPublicPage() {
  const { slug = '' } = useParams<{ slug: string }>()
  const [meta, setMeta] = useState<PortalMeta | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [categories, setCategories] = useState<PortalKbCategory[]>([])
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [articles, setArticles] = useState<PublicArticle[] | null>(null)
  const [article, setArticle] = useState<PublicArticle | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const debounceRef = useRef<number | undefined>(undefined)

  const loadArticles = useCallback(async (search: string, folderId?: string | null) => {
    try {
      const params = new URLSearchParams()
      if (search) params.set('q', search)
      if (folderId) params.set('folderId', folderId)
      const suffix = params.toString() ? `?${params}` : ''
      const res = await fetch(`/api/v1/public/portal/${encodeURIComponent(slug)}/kb${suffix}`)
      if (!res.ok) { setArticles([]); return }
      const body = (await res.json()) as { articles: PublicArticle[] }
      setArticles(body.articles)
    } catch {
      setArticles([])
    }
  }, [slug])

  useEffect(() => {
    let cancelled = false
    setNotFound(false)
    setError(null)
    fetch(`/api/v1/public/portal/${encodeURIComponent(slug)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('not found')
        const body = (await res.json()) as PortalMeta
        if (cancelled) return
        setMeta(body)
      })
      .catch(() => { if (!cancelled) setNotFound(true) })
    return () => { cancelled = true }
  }, [slug])

  // Load categories when KB is allowed
  useEffect(() => {
    if (!meta?.allowPublicKb) return
    portalKbCategories(slug).then((res) => setCategories(res.categories)).catch(() => setCategories([]))
  }, [meta, slug])

  useEffect(() => {
    if (!meta?.allowPublicKb) return
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(
      () => void loadArticles(query, activeCategory),
      query ? 300 : 0,
    )
    return () => window.clearTimeout(debounceRef.current)
  }, [query, meta, loadArticles, activeCategory])

  const openArticle = async (id: string) => {
    setError(null)
    try {
      const res = await fetch(`/api/v1/public/portal/${encodeURIComponent(slug)}/kb/${id}`)
      if (!res.ok) throw new Error('not found')
      const body = (await res.json()) as { article: PublicArticle }
      setArticle(body.article)
    } catch {
      setError('This article could not be opened.')
    }
  }

  if (notFound) return (
    <div className="auth-screen">
      <div className="auth-panel connect-panel connect-entry-panel">
        <BrandRow />
        <h1 className="auth-title">Portal not found</h1>
        <p className="auth-sub">This portal address is invalid, or the organisation has not published a portal. Ask your support team for the correct link.</p>
        <Link className="btn btn-ghost" to="/"><span>← Back to ReyDesk</span></Link>
      </div>
    </div>
  )

  if (meta === null) return <div className="auth-screen"><div className="auth-panel"><BrandRow /><span className="etch">Loading portal…</span></div></div>

  const accent = meta.branding.primaryColor || undefined
  const title = meta.branding.portalTitle || meta.name || 'Support portal'

  return (
    <div className="public-portal" style={accent ? ({ '--portal-accent': accent } as CSSProperties) : undefined}>
      <header className="public-portal-header">
        <div className="public-portal-header-inner">
          <div className="public-portal-brand">
            {meta.branding.logoUrl ? <img src={meta.branding.logoUrl} alt="" className="public-portal-logo" /> : null}
            <strong>{title}</strong>
          </div>
          <nav className="public-portal-nav">
            {meta.allowPublicKb ? <a href="#kb">Knowledge base</a> : null}
            <Link to="/login?next=/portal" className="btn btn-ghost btn-sm">Staff sign in</Link>
          </nav>
        </div>
      </header>

      <main className="public-portal-main">
        <section className="public-portal-hero">
          <span className="public-portal-kicker">SUPPORT CENTRE</span>
          <h1>How can we help?</h1>
          <p>Find an answer in the knowledge base or raise a request with the {meta.name} support team.</p>
          <div className="public-portal-actions">
            <Link to="/login?next=/portal/new" className="btn btn-primary btn-lg">
              <span>Submit a request</span>
            </Link>
            <Link to="/login?next=/portal" className="btn btn-ghost btn-lg">
              <span>Track my requests</span>
            </Link>
          </div>
        </section>

        {meta.allowPublicKb ? (
          <section id="kb" className="public-portal-kb">
            <div className="public-portal-kb-head">
              <div>
                <h2>Knowledge base</h2>
                <p>Self-service answers from {meta.name} — no sign-in required.</p>
              </div>
              <input
                className="field-input public-portal-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search articles…"
                aria-label="Search the knowledge base"
              />
            </div>

            {/* Category pills */}
            {categories.length > 0 ? (
              <div className="portal-kb-categories">
                <button
                  type="button"
                  className={`portal-kb-cat-pill ${activeCategory === null ? 'active' : ''}`}
                  onClick={() => setActiveCategory(null)}
                >
                  All
                </button>
                {categories.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    className={`portal-kb-cat-pill ${activeCategory === cat.id ? 'active' : ''}`}
                    onClick={() => setActiveCategory(cat.id)}
                  >
                    <Icon name="folder" size={13} />
                    {cat.name}
                    <span className="portal-kb-cat-count">{cat.article_count}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {articles === null ? (
              <span className="etch">Loading articles…</span>
            ) : articles.length === 0 ? (
              <div className="empty-state">
                <p>{query ? `No articles match "${query}".` : activeCategory ? 'No articles in this category.' : 'No public articles published yet.'}</p>
              </div>
            ) : (
              <div className="public-portal-article-grid">
                {articles.map((item) => (
                  <button key={item.id} type="button" className="public-portal-article" onClick={() => void openArticle(item.id)}>
                    <strong>{item.title}</strong>
                    {item.summary ? <span>{item.summary}</span> : null}
                    <small>Updated {formatWhen(item.updated_at)}</small>
                  </button>
                ))}
              </div>
            )}
          </section>
        ) : null}

        {article ? (
          <section className="public-portal-article-reader">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setArticle(null)}>
              ← All articles
            </button>
            <h2>{article.title}</h2>
            {article.summary ? <p className="muted">{article.summary}</p> : null}
            <div className="public-portal-article-body" dangerouslySetInnerHTML={{ __html: article.body ?? '' }} />
          </section>
        ) : null}

        {error ? (
          <div className="empty-state" style={{ marginTop: 20 }}>
            <p style={{ color: 'var(--warn)' }}>{error}</p>
          </div>
        ) : null}
      </main>

      <footer className="public-portal-footer">
        <span>Powered by <strong>ReyDesk</strong> — remote support and IT service management</span>
        <Link to="/login">Staff sign in</Link>
      </footer>
    </div>
  )
}
