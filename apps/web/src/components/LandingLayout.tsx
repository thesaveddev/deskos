import { Link, useLocation } from 'react-router-dom'
import { type ReactNode, useEffect, useState } from 'react'
import { useTheme } from '../lib/theme'
import { BRAND } from '../lib/brand.js'
import { Icon } from './Icons'

interface Props {
  children: ReactNode
  title?: string
  description?: string
  /** Page-specific JSON-LD structured data */
  structuredData?: Record<string, unknown>
  /** Canonical URL override (defaults to current path) */
  canonical?: string
}

const NAV_LINKS = [
  { to: '/features', label: 'Features' },
  { to: '/use-cases', label: 'Use Cases' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/support', label: 'Support' },
  { to: '/learn', label: 'Learn' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
]

const SITE_NAME = BRAND.name
const SITE_URL = BRAND.siteUrl
const DEFAULT_DESCRIPTION = 'Remote support, device management, and IT tickets in one app. Consent-first. Self-hostable.'
const OG_IMAGE = `${SITE_URL}${BRAND.ogImagePath}`

export default function LandingLayout({ children, title, description, structuredData, canonical }: Props) {
  const location = useLocation()
  const { theme, toggle } = useTheme()
  const [scrolled, setScrolled] = useState(false)

  const fullTitle = title || `${SITE_NAME} — IT Support OS`
  const pageDescription = description || DEFAULT_DESCRIPTION
  const canonicalUrl = canonical || `${SITE_URL}${location.pathname}`
  const ogTitle = title || `${SITE_NAME} — IT Support OS | Remote Support, RMM & ITSM`

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  // Update meta tags on mount / route change
  useEffect(() => {
    document.title = fullTitle

    const setMeta = (name: string, content: string, isProperty = false) => {
      const attr = isProperty ? 'property' : 'name'
      let el = document.querySelector(`meta[${attr}="${name}"]`) as HTMLMetaElement | null
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute(attr, name)
        document.head.appendChild(el)
      }
      el.setAttribute('content', content)
    }

    // Primary
    setMeta('description', pageDescription)
    setMeta('keywords', 'remote support, ITSM, RMM, endpoint management, remote desktop, ticketing, IT helpdesk, consent-first, AI assistant, patch management, IT support platform')
    setMeta('author', '34orients Ltd')
    setMeta('robots', 'index, follow')
    setMeta('theme-color', theme === 'dark' ? '#0e1114' : '#f8f9fb')

    // Canonical
    let canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
    if (!canonicalEl) {
      canonicalEl = document.createElement('link')
      canonicalEl.setAttribute('rel', 'canonical')
      document.head.appendChild(canonicalEl)
    }
    canonicalEl.setAttribute('href', canonicalUrl)

    // Open Graph
    setMeta('og:type', 'website', true)
    setMeta('og:url', canonicalUrl, true)
    setMeta('og:title', ogTitle, true)
    setMeta('og:description', pageDescription, true)
    setMeta('og:image', OG_IMAGE, true)
    setMeta('og:image:width', '1200', true)
    setMeta('og:image:height', '630', true)
    setMeta('og:site_name', SITE_NAME, true)
    setMeta('og:locale', 'en_GB', true)

    // Twitter
    setMeta('twitter:card', 'summary_large_image')
    setMeta('twitter:url', canonicalUrl)
    setMeta('twitter:title', ogTitle)
    setMeta('twitter:description', pageDescription)
    setMeta('twitter:image', OG_IMAGE)

    return () => { document.title = SITE_NAME }
  }, [fullTitle, pageDescription, canonicalUrl, ogTitle, theme])

  // Default organization structured data
  const orgJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}/reydesk-icon.svg`,
    description: DEFAULT_DESCRIPTION,
    address: { '@type': 'PostalAddress', addressCountry: 'GB' },
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'customer support',
      email: 'support@reydesk.com',
      availableLanguage: 'English',
    },
    sameAs: [
      'https://github.com/thesaveddev/reydesk',
      'https://twitter.com/reydesk',
      'https://linkedin.com/company/reydesk',
    ],
  }

  const webSiteJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_URL,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${SITE_URL}/?q={search_term_string}`,
      'query-input': 'required name=search_term_string',
    },
  }

  return (
    <div className="landing">
      {/* SEO: Organization + Website structured data */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(orgJsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteJsonLd) }} />
      {structuredData && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }} />
      )}

      {/* ---- sticky nav ---- */}
      <header className={`landing-nav${scrolled ? ' scrolled' : ''}`}>
        <div className="landing-nav-inner">
          <Link to="/" className="landing-nav-brand-link">
            <span className="brand">ReyDesk</span>
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
          <button className="theme-toggle" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
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
            <span className="brand">ReyDesk</span>
            <p className="landing-footer-tagline">Remote support, device management, and ticketing.</p>
            <div className="landing-footer-social">
              <a href="https://github.com/thesaveddev/reydesk" target="_blank" rel="noreferrer" aria-label="GitHub">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
              </a>
              <a href="https://twitter.com/reydesk" target="_blank" rel="noreferrer" aria-label="Twitter">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </a>
              <a href="https://linkedin.com/company/reydesk" target="_blank" rel="noreferrer" aria-label="LinkedIn">
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
            <a href="https://github.com/thesaveddev/reydesk" target="_blank" rel="noreferrer">GitHub</a>
          </div>
          <div className="landing-footer-col">
            <h4>Resources</h4>
            <Link to="/support">Support</Link>
            <Link to="/learn">Learn</Link>
            <a href="#faq">FAQ</a>
            <Link to="/login">Customer Portal</Link>
            <a href="mailto:hello@reydesk.com">General Enquiries</a>
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
          <span className="muted">&copy; {new Date().getFullYear()} ReyDesk by <a href="https://34orients.com" target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>34orients Ltd</a>. All rights reserved.</span>
        </div>
      </footer>
    </div>
  )
}
