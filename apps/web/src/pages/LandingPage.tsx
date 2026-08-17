import { Link } from 'react-router-dom'
import { useEffect } from 'react'

/* ---------- SEO: set meta tags on mount ---------- */
const SEO = {
  title: 'DeskOS — IT Support OS | Remote Support, RMM & ITSM in One Console',
  description:
    'DeskOS unifies remote control, endpoint management, and IT service management in one consent-first, AI-assisted platform. Deploy in minutes, not months.',
  url: 'https://www.deskos.com',
  ogImage: '/og-deskos.png',
}

/* ---------- data ---------- */

const FEATURES = [
  {
    icon: '🖥️',
    title: 'Remote support, AnyDesk-class',
    body: 'Attended or unattended sessions with end-to-end encrypted WebRTC media, a one-time-code journey for unmanaged devices, and a portable helper that needs no installation.',
  },
  {
    icon: '📊',
    title: 'RMM & DEX',
    body: 'Structured inventory, endpoint policies, bulk actions, DEX health scores, and security-posture evaluation on every telemetry sample — before things break.',
  },
  {
    icon: '🎫',
    title: 'ITSM depth',
    body: 'Tickets with SLA business-hours math, a service catalogue with approvals, problem & change management, major incident command centre, patch rollouts, and a customer portal.',
  },
  {
    icon: '🤖',
    title: 'AI on a leash',
    body: 'Ticket summaries, similar-incident detection, KB drafting, and a bounded Level-1 agent that proposes remediations — a human always approves before anything runs.',
  },
  {
    icon: '🔒',
    title: 'Security you can show auditors',
    body: 'Hash-chained audit log, consent that cannot be bypassed, JIT privileged access with checkout/check-in, MFA + passkeys, and row-level tenant isolation.',
  },
  {
    icon: '🔌',
    title: 'Plays well with your stack',
    body: 'Entra/M365 and on-prem Active Directory sync, Slack/Teams webhooks, OAuth2 + OpenAPI for integrators, and Web Push so you never miss an alert.',
  },
]

const USE_CASES = [
  {
    title: 'MSPs & IT service providers',
    body: 'Manage multiple customer tenants from one cross-tenant console. Per-customer branding, SLA tracking, and a customer-facing portal — all without switching tools.',
  },
  {
    title: 'Internal IT departments',
    body: 'One console for your helpdesk, endpoint fleet, and compliance audits. SLA tracking, automation rules, and a knowledge base keep resolution times short.',
  },
  {
    title: 'Education & healthcare',
    body: 'Consent-first remote support with full audit trails. Deploy silently with Group Policy. Web Push alerts reach technicians even when they are away from the console.',
  },
  {
    title: 'SaaS & software companies',
    body: 'Customer-assisted support without pre-installed agents. Generate a code, walk the user through it, and take control in seconds — no account required on their end.',
  },
]

const COMPARISON = [
  { feature: 'Native remote control', deskos: '✅ built-in', teamviewer: '✅ built-in', splashtop: '✅ built-in', anydesk: '✅ built-in' },
  { feature: 'Endpoint management', deskos: '✅ built-in', teamviewer: '⚠️ separate product', splashtop: '⚠️ separate product', anydesk: '⚠️ remote only' },
  { feature: 'ITSM ticketing', deskos: '✅ built-in', teamviewer: '❌', splashtop: '❌', anydesk: '❌' },
  { feature: 'AI assistant', deskos: '✅ built-in', teamviewer: '❌', splashtop: '❌', anydesk: '❌' },
  { feature: 'Consent-first design', deskos: '✅ enforced', teamviewer: '⚠️', splashtop: '⚠️', anydesk: '⚠️' },
  { feature: 'Hash-chained audit', deskos: '✅ built-in', teamviewer: '❌', splashtop: '❌', anydesk: '❌' },
  { feature: 'Multi-tenant MSP', deskos: '✅ first-class', teamviewer: '⚠️ add-on', splashtop: '❌', anydesk: '❌' },
  { feature: 'Web Push notifications', deskos: '✅ built-in', teamviewer: '❌', splashtop: '❌', anydesk: '❌' },
  { feature: 'OpenAPI / OAuth2', deskos: '✅ built-in', teamviewer: '⚠️', splashtop: '❌', anydesk: '❌' },
  { feature: 'Self-hosted option', deskos: '✅ VPS deploy', teamviewer: '❌', splashtop: '❌', anydesk: '❌' },
]

const DEPLOYMENTS = [
  {
    tag: 'Customer-assisted',
    title: 'Send the MSI and a code',
    body: 'The user installs the agent, opens Enroll DeskOS Agent, and enters one six-to-eight-digit code. No terminal, no credentials.',
  },
  {
    tag: 'Technician-assisted',
    title: 'Guide them live',
    body: 'Generate a support code during the call. The endpoint user approves consent, and you take control without preinstalled software.',
  },
  {
    tag: 'IT fleet deployment',
    title: 'Roll out at scale',
    body: 'Protected MSI properties carry a bootstrap token for Intune, Group Policy, or any endpoint platform — silent, scripted enrolment.',
  },
]

const FAQ = [
  {
    q: 'What does "consent-first" mean?',
    a: 'Every remote session requires explicit user consent. There is no way to bypass this — the agent enforces it at the protocol level, and every consent event is recorded in the audit log.',
  },
  {
    q: 'Is DeskOS self-hosted or cloud?',
    a: 'Both. DeskOS runs on a single VPS (PostgreSQL + Redis co-located) for small deployments and scales horizontally. A Docker Compose stack is included. You own your data.',
  },
  {
    q: 'Do I need Rust on the managed devices?',
    a: 'No. The agent is a compiled Windows binary — you distribute the MSI. The Rust toolchain is only needed to build the agent from source.',
  },
  {
    q: 'How does the AI agent work?',
    a: 'The Level-1 agent proposes bounded remediations (restart, collect inventory, add ticket note) from a fixed tool catalog. Nothing runs until a human approves it. The AI provider is optional — deterministic fallback when disabled.',
  },
  {
    q: 'Can I connect from my phone?',
    a: 'Yes. DeskOS has a responsive web console that works on any browser. Web Push notifications alert you to new sessions and alerts even when the app is closed.',
  },
  {
    q: 'What about data privacy?',
    a: 'Every table is tenant-isolated at the database level (Row-Level Security). Audit logs are hash-chained and tamper-evident. Remote sessions are end-to-end encrypted. See our Privacy Policy for details.',
  },
]

/* ---------- component ---------- */

export default function LandingPage() {
  useEffect(() => {
    document.title = SEO.title
    const meta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
      if (!el) {
        el = document.createElement('meta')
        el.setAttribute('name', name)
        document.head.appendChild(el)
      }
      el.setAttribute('content', content)
    }
    meta('description', SEO.description)
    meta('og:title', SEO.title)
    meta('og:description', SEO.description)
    meta('og:image', SEO.ogImage)
    meta('og:url', SEO.url)
    meta('twitter:card', 'summary_large_image')
    meta('twitter:title', SEO.title)
    meta('twitter:description', SEO.description)
    meta('twitter:image', SEO.ogImage)
    return () => {
      document.title = 'DeskOS'
    }
  }, [])

  return (
    <div className="landing">
      {/* ---- nav ---- */}
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <span className="brand">DeskOS</span>
          <span className="etch">IT SUPPORT OS</span>
          <div className="landing-nav-spacer" />
          <a className="landing-nav-link" href="#features">Features</a>
          <a className="landing-nav-link" href="#use-cases">Use cases</a>
          <a className="landing-nav-link" href="/pricing">Pricing</a>
          <a className="landing-nav-link" href="#faq">FAQ</a>
          <Link className="btn btn-ghost btn-sm" to="/login">Sign in</Link>
          <Link className="btn btn-primary btn-sm" to="/signup">Get started</Link>
        </div>
      </header>

      {/* ---- hero ---- */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Remote support · RMM · ITSM · AI</span>
          <h1 className="landing-title">The IT support OS that thinks ahead.</h1>
          <p className="landing-sub">
            DeskOS unifies remote control, endpoint management, and service desk in one console — with consent-first security, an audited trail for everything, and AI that proposes while humans decide.
          </p>
          <div className="landing-cta">
            <Link className="btn btn-primary" to="/signup">Start for free</Link>
            <Link className="btn btn-ghost" to="/login">Sign in</Link>
          </div>
          <p className="landing-sub" style={{ fontSize: 13, marginBottom: 0 }}>
            Free for up to 3 technicians · No credit card required
          </p>
        </div>

        {/* console mockup */}
        <div className="landing-console" aria-hidden="true">
          <div className="landing-console-bar">
            <span className="landing-dot" style={{ background: 'var(--crit)' }} />
            <span className="landing-dot" style={{ background: 'var(--warn)' }} />
            <span className="landing-dot" style={{ background: 'var(--ok)' }} />
            <span className="landing-console-title mono">DeskOS — technician console</span>
          </div>
          <div className="landing-console-body">
            <div className="landing-console-rail">
              <span className="landing-rail-item active">Tickets</span>
              <span className="landing-rail-item">Devices</span>
              <span className="landing-rail-item">Sessions</span>
              <span className="landing-rail-item">Endpoints</span>
              <span className="landing-rail-item">Incidents</span>
            </div>
            <div className="landing-console-main">
              <div className="landing-stat-row">
                <div className="landing-stat"><strong>42</strong><span>open tickets</span></div>
                <div className="landing-stat"><strong>318</strong><span>devices online</span></div>
                <div className="landing-stat"><strong>3</strong><span>live sessions</span></div>
                <div className="landing-stat ok"><strong>98.6%</strong><span>SLA compliance</span></div>
              </div>
              <div className="landing-table">
                <div className="landing-table-row head"><span>#</span><span>Subject</span><span>Status</span><span>SLA</span></div>
                <div className="landing-table-row"><span className="mono">1042</span><span>Printer on floor 3 offline</span><span className="pill ok">in progress</span><span className="mono ok">on time</span></div>
                <div className="landing-table-row"><span className="mono">1041</span><span>VPN access for contractor</span><span className="pill warn">pending user</span><span className="mono warn">2h left</span></div>
                <div className="landing-table-row"><span className="mono">1040</span><span>High CPU on YEMIS-LAPTOP</span><span className="pill crit">escalated</span><span className="mono crit">overdue</span></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---- social proof ---- */}
      <section className="landing-proof">
        <div className="landing-proof-inner">
          <span className="landing-proof-stat"><strong>345+</strong> API tests</span>
          <span className="landing-proof-sep">·</span>
          <span className="landing-proof-stat"><strong>100%</strong> consent-enforced</span>
          <span className="landing-proof-sep">·</span>
          <span className="landing-proof-stat"><strong>E2E</strong> encrypted sessions</span>
          <span className="landing-proof-sep">·</span>
          <span className="landing-proof-stat"><strong>Audit</strong> hash-chained</span>
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="landing-section" id="features">
        <div className="landing-section-head">
          <span className="landing-kicker">One console, the whole job</span>
          <h2 className="landing-h2">Everything your team touches, in one place.</h2>
          <p className="landing-section-sub">
            Remote support, endpoint management, ticketing, AI, security, and integrations — not a bundle of six products bolted together.
          </p>
        </div>
        <div className="landing-features">
          {FEATURES.map((f) => (
            <article key={f.title} className="landing-feature">
              <span className="landing-feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- use cases ---- */}
      <section className="landing-section" id="use-cases">
        <div className="landing-section-head">
          <span className="landing-kicker">Who it's for</span>
          <h2 className="landing-h2">DeskOS fits every IT team.</h2>
        </div>
        <div className="landing-features">
          {USE_CASES.map((u) => (
            <article key={u.title} className="landing-feature">
              <h3>{u.title}</h3>
              <p>{u.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- deployment ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Deployment</span>
          <h2 className="landing-h2">Three ways to get a device connected.</h2>
          <p className="landing-section-sub">
            From a single ad-hoc support code to a fleet-wide Group Policy rollout — DeskOS meets you where you are.
          </p>
        </div>
        <div className="landing-deploys">
          {DEPLOYMENTS.map((d) => (
            <article key={d.tag} className="landing-deploy">
              <span className="etch">{d.tag}</span>
              <h3>{d.title}</h3>
              <p>{d.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ---- comparison ---- */}
      <section className="landing-section" id="comparison">
        <div className="landing-section-head">
          <span className="landing-kicker">Why DeskOS</span>
          <h2 className="landing-h2">How it stacks up.</h2>
          <p className="landing-section-sub">
            Most IT teams stitch together 3–4 tools. DeskOS replaces them with one.
          </p>
        </div>
        <div className="landing-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>DeskOS</th>
                <th>TeamViewer</th>
                <th>Splashtop</th>
                <th>AnyDesk</th>
              </tr>
            </thead>
            <tbody>
              {COMPARISON.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td className="mono">{row.deskos}</td>
                  <td className="mono">{row.teamviewer}</td>
                  <td className="mono">{row.splashtop}</td>
                  <td className="mono">{row.anydesk}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ---- FAQ ---- */}
      <section className="landing-section" id="faq">
        <div className="landing-section-head">
          <span className="landing-kicker">Questions</span>
          <h2 className="landing-h2">Frequently asked questions.</h2>
        </div>
        <div className="landing-faq">
          {FAQ.map((item) => (
            <details key={item.q} className="landing-faq-item">
              <summary className="landing-faq-q">{item.q}</summary>
              <p className="landing-faq-a">{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---- CTA ---- */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">Ready to take control of your fleet?</h2>
        <p className="landing-sub">
          Create your workspace in under a minute — no sales call, no credit card, no install.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup">Create your workspace</Link>
        </div>
      </section>

      {/* ---- footer ---- */}
      <footer className="landing-footer">
        <div className="landing-footer-grid">
          <div className="landing-footer-brand">
            <span className="brand">DeskOS</span>
            <p className="landing-footer-tagline">IT Support OS — remote support, RMM, and ITSM in one console.</p>
          </div>
          <div className="landing-footer-col">
            <h4>Product</h4>
            <a href="#features">Features</a>
            <a href="#use-cases">Use cases</a>
            <a href="/pricing">Pricing</a>
            <a href="#comparison">Compare</a>
            <Link to="/login">Sign in</Link>
            <Link to="/signup">Get started</Link>
          </div>
          <div className="landing-footer-col">
            <h4>Resources</h4>
            <a href="#faq">FAQ</a>
            <Link to="/login">Customer portal</Link>
            <a href="/api/v1/openapi.json">API docs (OpenAPI)</a>
          </div>
          <div className="landing-footer-col">
            <h4>Legal</h4>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/about">About us</Link>
          </div>
        </div>
        <div className="landing-footer-bottom">
          <span className="muted">&copy; {new Date().getFullYear()} DeskOS. All rights reserved.</span>
        </div>
      </footer>

      {/* JSON-LD structured data for SEO */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'SoftwareApplication',
            name: 'DeskOS',
            applicationCategory: 'BusinessApplication',
            description: SEO.description,
            url: SEO.url,
            offers: {
              '@type': 'Offer',
              price: '0',
              priceCurrency: 'USD',
              description: 'Free for up to 3 technicians',
            },
          }),
        }}
      />
    </div>
  )
}
