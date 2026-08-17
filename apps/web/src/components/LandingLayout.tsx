import { Link, useLocation } from 'react-router-dom'
import { type ReactNode, useEffect, useState } from 'react'
import { useTheme } from '../lib/theme'

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
  { to: '/contact', label: 'Contact' },
]

export default function LandingLayout({ children, title, description }: Props) {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

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
      {/* ---- sticky nav ---- */}
      <header className={`landing-nav${scrolled ? ' scrolled' : ''}`}>
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
          <Link className="landing-nav-link" to="/api-docs">API</Link>
          <button className="theme-toggle" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
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
              <a href="https://twitter.com/deskos" target="_blank" rel="noreferrer" aria-label="Twitter">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </a>
              <a href="https://linkedin.com/company/deskos" target="_blank" rel="noreferrer" aria-label="LinkedIn">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
              </a>
            </div>
          </div>
          <div className="landing-footer-col">
            <h4>Product</h4>
            <Link to="/features">Features</Link>
            <Link to="/use-cases">Use Cases</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/api-docs">API Docs</Link>
            <a href="https://github.com/thesaveddev/deskos" target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <div className="landing-footer-col">
            <h4>Resources</h4>
            <a href="#faq">FAQ</a>
            <Link to="/login">Customer Portal</Link>
            <a href="mailto:support@deskos.com">Support</a>
            <a href="mailto:hello@deskos.com">General Enquiries</a>
          </div>
          <div className="landing-footer-col">
            <h4>Company</h4>
            <Link to="/about">About Us</Link>
            <Link to="/contact">Contact</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span className="muted">&copy; {new Date().getFullYear()} DeskOS by Clean IT Ltd. All rights reserved.</span>
        </div>
      </footer>
    </div>
  )
}
