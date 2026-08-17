import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

export default function AboutPage() {
  return (
    <LandingLayout
      title="About — DeskOS | The IT Support OS"
      description="About DeskOS — the IT support platform built by Clean IT Ltd. Our mission: one console for every IT task."
    >
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

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">By the numbers</h2>
        </div>
        <div className="landing-features">
          <article className="landing-feature">
            <span className="landing-feature-icon">365</span>
            <h3>API tests</h3>
            <p>Every endpoint is tested. CI runs the full suite on every push.</p>
          </article>
          <article className="landing-feature">
            <span className="landing-feature-icon">38</span>
            <h3>Database migrations</h3>
            <p>Schema-versioned with Row-Level Security on every tenant-scoped table.</p>
          </article>
          <article className="landing-feature">
            <span className="landing-feature-icon">100%</span>
            <h3>Consent-enforced</h3>
            <p>No remote session can start without explicit user consent. No exceptions.</p>
          </article>
        </div>
      </section>

      <section className="landing-cta-band">
        <h2 className="landing-h2">Get in touch</h2>
        <p className="landing-sub">
          Questions, feedback, or partnership enquiries — we'd love to hear from you.
        </p>
        <div className="landing-cta">
          <a className="btn btn-primary" href="mailto:hello@deskos.com">Email us</a>
          <Link className="btn btn-ghost" to="/signup">Try it free</Link>
        </div>
      </section>
    </LandingLayout>
  )
}
