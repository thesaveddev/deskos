import { Link, useLocation } from 'react-router-dom'
import { type ReactNode, useEffect } from 'react'

interface Props {
  children: ReactNode
  title?: string
  description?: string
}

const NAV_LINKS = [
  { to: '/features', label: 'Features' },
  { to: '/use-cases', label: 'Use Cases' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/about', label: 'About' },
]

export default function LandingLayout({ children, title, description }: Props) {
  const location = useLocation()

  useEffect(() => {
    document.title = title || 'DeskOS — IT Support OS'
    const meta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute('name', name)
        document.head.appendChild(el)
      }
      el.setAttribute('content', content)
    }
    if (description) {
      meta('description', description)
      meta('og:description', description)
    }
    if (title) {
      meta('og:title', title)
    }
    meta('og:image', '/og-deskos.png')
    meta('og:url', 'https://www.deskos.com' + location.pathname)
    meta('twitter:card', 'summary_large_image')
    return () => { document.title = 'DeskOS' }
  }, [title, description, location.pathname])

  return (
    <div className="landing">
      {/* ---- nav ---- */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link to="/" className="landing-nav-brand-link">
            <span className="brand">DeskOS</span>
          </Link>
          <span className="etch">IT SUPPORT OS</span>
          <div className="landing-nav-spacer" />
          {NAV_LINKS.map((l) => (
            <Link
              key={l.to}
              className={`landing-nav-link${location.pathname === l.to ? ' active' : ''}`}
              to={l.to}
            >
              {l.label}
            </Link>
          ))}
          <a className="landing-nav-link" href="/api/v1/openapi.json" target="_blank" rel="noreferrer">API</a>
          <Link className="btn btn-ghost btn-sm" to="/login">Sign in</Link>
          <Link className="btn btn-primary btn-sm" to="/signup">Get started</Link>
        </div>
      </header>

      {/* ---- page content ---- */}
      {children}

      {/* ---- footer ---- */}
      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="brand">DeskOS</span>
            <p className="landing-footer-tagline">IT Support OS — remote support, RMM, and ITSM in one console.</p>
            <div className="landing-footer-social">
              <a href="https://github.com/thesaveddev/deskos" target="_blank" rel="noreferrer" aria-label="GitHub">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              </a>
            </div>
          </div>
          <div className="landing-footer-col">
            <h4>Product</h4>
            <Link to="/features">Features</Link>
            <Link to="/use-cases">Use Cases</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/login">Sign in</Link>
            <Link to="/signup">Get started free</Link>
          </div>
          <div className="landing-footer-col">
            <h4>Resources</h4>
            <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer">API Docs</a>
            <a href="https://github.com/thesaveddev/deskos" target="_blank" rel="noreferrer">GitHub</a>
            <a href="#faq">FAQ</a>
            <Link to="/login">Customer Portal</Link>
          </div>
          <div className="landing-footer-col">
            <h4>Company</h4>
            <Link to="/about">About Us</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <a href="mailto:support@deskos.com">Contact</a>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span className="muted">&copy; {new Date().getFullYear()} DeskOS. All rights reserved.</span>
        </div>
      </footer>
    </div>
  )
}
