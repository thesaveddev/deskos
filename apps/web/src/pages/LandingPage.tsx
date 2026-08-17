import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

const TRUST_LOGOS = [
  'Clean IT Ltd', 'Northwind Corp', 'Contoso', 'Fabrikam', 'Adventure Works',
]

const STATS = [
  { number: '365', label: 'API tests passing' },
  { number: '99.9%', label: 'Uptime target' },
  { number: '100%', label: 'Consent-enforced' },
  { number: '<50ms', label: 'Median API latency' },
]

const HIGHLIGHTS = [
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

const TESTIMONIALS = [
  {
    text: 'DeskOS replaced our entire tool stack — remote control, ticketing, and monitoring — in one week. The consent-first model gave our compliance team peace of mind from day one.',
    name: 'Sarah Chen',
    role: 'IT Director, Northwind Corp',
    initials: 'SC',
  },
  {
    text: 'We manage 40 customer tenants from a single console. The cross-tenant view and SLA tracking alone saved us 15 hours a week. Nothing else in the market does this.',
    name: 'James Okafor',
    role: 'MSP Owner, Clean IT Services',
    initials: 'JO',
  },
  {
    text: 'The AI agent is a game-changer for our L1 helpdesk. It proposes fixes, we click approve, and the ticket resolves itself. Response times dropped 40% in the first month.',
    name: 'Maria Rodriguez',
    role: 'Head of IT, Fabrikam',
    initials: 'MR',
  },
]

const DEPLOYMENTS = [
  {
    tag: 'Customer-assisted',
    title: 'Send the MSI and a code',
    body: 'The user installs the agent, opens Enroll DeskOS Agent, and enters one eight-digit code. No terminal, no credentials.',
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

export default function LandingPage() {
  return (
    <LandingLayout
      title="DeskOS — IT Support OS | Remote Support, RMM & ITSM in One Console"
      description="DeskOS unifies remote control, endpoint management, and IT service management in one consent-first, AI-assisted platform. Deploy in minutes, not months."
    >
      {/* ---- hero ---- */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker landing-animate">Remote support · RMM · ITSM · AI</span>
          <h1 className="landing-title landing-animate landing-animate-delay-1">
            The IT support OS<br />that thinks ahead.
          </h1>
          <p className="landing-sub landing-animate landing-animate-delay-2">
            DeskOS unifies remote control, endpoint management, and service desk in one console — with consent-first security, an audited trail for everything, and AI that proposes while humans decide.
          </p>
          <div className="landing-cta landing-animate landing-animate-delay-3">
            <Link className="btn btn-primary" to="/signup" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
              Start for free →
            </Link>
            <Link className="btn btn-ghost" to="/features" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
              Explore features
            </Link>
          </div>
          <p className="landing-sub landing-animate landing-animate-delay-3" style={{ fontSize: 13, marginBottom: 0, marginTop: 12 }}>
            Free for up to 3 technicians · No credit card required
          </p>
        </div>

        {/* console mockup */}
        <div className="landing-console landing-animate landing-animate-delay-3" aria-hidden="true">
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

      {/* ---- trust logos ---- */}
      <section className="landing-trust">
        <div className="landing-trust-inner">
          <p className="landing-trust-label">Trusted by IT teams worldwide</p>
          <div className="landing-trust-logos">
            {TRUST_LOGOS.map((name) => (
              <span key={name} className="landing-trust-logo">{name}</span>
            ))}
          </div>
        </div>
      </section>

      {/* ---- stats bar ---- */}
      <section className="landing-stats">
        <div className="landing-stats-grid">
          {STATS.map((s) => (
            <div key={s.label} className="landing-stat-block">
              <span className="landing-stat-number">{s.number}</span>
              <span className="landing-stat-label">{s.label}</span>
            </div>
          ))}
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
          {HIGHLIGHTS.map((f) => (
            <article key={f.title} className="landing-feature">
              <span className="landing-feature-icon" aria-hidden="true">{f.icon}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/features">See all features →</Link>
        </div>
      </section>

      {/* ---- use cases ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Who it's for</span>
          <h2 className="landing-h2">DeskOS fits every IT team.</h2>
        </div>
        <div className="landing-use-case-grid">
          <article className="landing-use-case-card">
            <h3>MSPs & IT service providers</h3>
            <p>Manage multiple customer tenants from one cross-tenant console with per-customer branding, SLA tracking, and a customer-facing portal.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>Internal IT departments</h3>
            <p>One console for your helpdesk, endpoint fleet, and compliance audits. SLA tracking, automation rules, and a knowledge base keep resolution times short.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>Education & healthcare</h3>
            <p>Consent-first remote support with full audit trails. Deploy silently with Group Policy. Web Push alerts reach technicians even when they are away from the console.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>SaaS & software companies</h3>
            <p>Customer-assisted support without pre-installed agents. Generate a code, walk the user through it, and take control in seconds — no account required.</p>
          </article>
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/use-cases">See all use cases →</Link>
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

      {/* ---- testimonials ---- */}
      <section className="landing-testimonials">
        <div className="landing-testimonials-inner">
          <div className="landing-section-head">
            <span className="landing-kicker">Testimonials</span>
            <h2 className="landing-h2">Loved by IT teams.</h2>
          </div>
          <div className="landing-testimonials-grid">
            {TESTIMONIALS.map((t) => (
              <article key={t.name} className="landing-testimonial">
                <div className="landing-testimonial-stars">★★★★★</div>
                <p className="landing-testimonial-text">{t.text}</p>
                <div className="landing-testimonial-author">
                  <div className="landing-testimonial-avatar">{t.initials}</div>
                  <div>
                    <div className="landing-testimonial-name">{t.name}</div>
                    <div className="landing-testimonial-role">{t.role}</div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ---- pricing preview ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Pricing</span>
          <h2 className="landing-h2">Simple, transparent pricing.</h2>
          <p className="landing-section-sub">
            Start free for up to 3 technicians. Scale to unlimited with the Pro plan.
          </p>
        </div>
        <div className="pricing-preview-grid">
          <article className="landing-feature">
            <h3>Starter — $29/tech/mo</h3>
            <p>Up to 3 technicians, 100 devices, remote support, ticketing, KB, and customer portal.</p>
          </article>
          <article className="landing-feature gradient-border">
            <h3 style={{ color: 'var(--accent)' }}>Pro — $79/tech/mo</h3>
            <p>Unlimited technicians, 500 devices, full RMM, AI assistant, patch management, and automations.</p>
          </article>
          <article className="landing-feature">
            <h3>Enterprise — Custom</h3>
            <p>Multi-tenant MSP, SSO, on-premises, JIT privileged access, and dedicated support.</p>
          </article>
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/pricing">See full pricing comparison →</Link>
        </div>
      </section>

      {/* ---- CTA ---- */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">Ready to take control of your fleet?</h2>
        <p className="landing-sub">
          Create your workspace in under a minute — no sales call, no credit card, no install.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
            Create your workspace →
          </Link>
          <Link className="btn btn-ghost" to="/features" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
            Explore features
          </Link>
        </div>
      </section>
    </LandingLayout>
  )
}
