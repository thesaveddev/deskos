import { Link } from 'react-router-dom'
import { useEffect } from 'react'

export default function AboutPage() {
  useEffect(() => {
    document.title = 'About — DeskOS'
    const meta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
      if (!el) { el = document.createElement('meta'); el.setAttribute('name', name); document.head.appendChild(el) }
      el.setAttribute('content', content)
    }
    meta('description', 'About DeskOS — the IT support platform built by Clean IT Ltd. Our mission: one console for every IT task.')
    return () => { document.title = 'DeskOS' }
  }, [])

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link className="brand" to="/" style={{ textDecoration: 'none' }}>DeskOS</Link>
          <div className="landing-nav-spacer" />
          <Link className="btn btn-ghost btn-sm" to="/">Home</Link>
          <Link className="btn btn-primary btn-sm" to="/signup">Get started</Link>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">About us</span>
          <h1 className="landing-title">One console for every IT task.</h1>
          <p className="landing-sub">
            We built DeskOS because IT teams were drowning in tool sprawl — stitching together remote control, ticketing, monitoring, and compliance into a Frankenstein stack that nobody loved.
          </p>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">Our mission</h2>
        </div>
        <div className="legal-content">
          <p>
            We believe that a small IT team — or even a single person — should be able to manage a fleet of endpoints, support remote users, track every action, and stay compliant, all from one clean, fast, well-designed console.
          </p>
          <p>
            DeskOS is that console. We combine remote support, RMM, ITSM, AI assistance, and security into a single platform with consent-first design, hash-chained audit logs, and end-to-end encrypted sessions.
          </p>
          <p>
            We are building for the long term — no vendor lock-in, no dark patterns, no data harvesting. You own your data, your audit trail, and your infrastructure.
          </p>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">Why we exist</h2>
        </div>
        <div className="legal-content">
          <h3>The problem</h3>
          <p>
            Most IT teams use 3–5 separate tools: a remote control app, a ticketing system, an endpoint monitoring platform, a knowledge base, and a compliance tracker. Each tool has its own login, its own data model, and its own subscription. The result: context switching everywhere, inconsistent audit trails, and a lot of money spent on integrations that barely work.
          </p>

          <h3>Our answer</h3>
          <p>
            DeskOS is a single product that does the whole job. Remote sessions, tickets, devices, automation, knowledge, patches, compliance — all sharing the same data model, the same audit chain, and the same consent-first security model. One login. One console. One bill.
          </p>

          <h3>Who we are</h3>
          <p>
            DeskOS is built by <strong>Clean IT Ltd</strong>, a UK-based company focused on building IT operations tools that are honest, secure, and genuinely useful. We believe that good software should be transparent about what it does and respectful of the people who use it.
          </p>
        </div>
      </section>

      <section className="landing-cta-band">
        <h2 className="landing-h2">Get in touch</h2>
        <p className="landing-sub">
          Questions, feedback, or partnership enquiries — we'd love to hear from you.
        </p>
        <div className="landing-cta">
          <a className="btn btn-primary" href="mailto:hello@deskos.com">Email us</a>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="brand">DeskOS</span>
            <p className="landing-footer-tagline">IT Support OS</p>
          </div>
          <div className="landing-footer-col">
            <h4>Product</h4>
            <a href="/#features">Features</a>
            <Link to="/pricing">Pricing</Link>
            <Link to="/login">Sign in</Link>
          </div>
          <div className="landing-footer-col">
            <h4>Legal</h4>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/about">About</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span className="muted">&copy; {new Date().getFullYear()} DeskOS. All rights reserved.</span>
        </div>
      </footer>
    </div>
  )
}
