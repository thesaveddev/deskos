import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

const USE_CASES = [
  {
    icon: '🏢',
    title: 'MSPs & IT service providers',
    subtitle: 'Multiple customers, one view.',
    description:
      'DeskOS is built for multi-tenant operations. Manage multiple customer tenants from one cross-tenant console with per-customer branding, SLA tracking, and a customer-facing portal — all without switching tools.',
    features: [
      'Cross-tenant technician console',
      'Per-customer branding and SLA',
      'Customer self-service portal',
      'Consent-first remote sessions',
      'Audit logs per tenant',
    ],
  },
  {
    icon: '🖥️',
    title: 'Internal IT departments',
    subtitle: 'One console for helpdesk, endpoints, and compliance.',
    description:
      'Tickets, devices, and remote access in one app. SLA tracking, device health scores, and compliance reports without switching between tools.',
    features: [
      'Ticketing with business-hours SLA',
      'Endpoint health & DEX scoring',
      'Patch management with ring rollout',
      'Knowledge base with AI drafting',
      'Automations for repetitive tasks',
    ],
  },
  {
    icon: '🏥',
    title: 'Education & healthcare',
    subtitle: 'Consent-first support with full audit trails.',
    description:
      'In regulated environments, every remote session needs a paper trail. DeskOS enforces consent at the protocol level, records every action in a hash-chained audit log, and supports silent deployment via Group Policy.',
    features: [
      'Consent enforced at protocol level',
      'Hash-chained audit trails',
      'Silent Group Policy deployment',
      'Web Push for technician alerts',
      'HIPAA-friendly architecture',
    ],
  },
  {
    icon: '💼',
    title: 'SaaS & software companies',
    subtitle: 'Customer support without pre-installed agents.',
    description:
      'Your customers should not have to install software for you to help them. Generate a one-time code, walk the user through it, and take control in seconds — no account required on their end.',
    features: [
      'One-time code for ad-hoc support',
      'No account needed on user end',
      'Portable helper (no install)',
      'In-session chat and file transfer',
      'Session recording for QA',
    ],
  },
  {
    icon: '🏭',
    title: 'Managed service & field ops',
    subtitle: 'Unattended device management at scale.',
    description:
      'POS systems, kiosks, digital signage, IoT gateways — manage thousands of unattended devices with bulk actions, policy enforcement, and real-time alerting.',
    features: [
      'Silent agent deployment at scale',
      'Bulk device actions',
      'Policy-based configuration',
      'Real-time health monitoring',
      'Remote terminal & file access',
    ],
  },
  {
    icon: '🔒',
    title: 'Security-conscious orgs',
    subtitle: 'Zero-standing-privilege architecture.',
    description:
      'JIT privileged access, MFA + passkeys, row-level tenant isolation, and session recording. DeskOS is designed for organizations that need to prove compliance.',
    features: [
      'Just-in-time privileged access',
      'MFA + WebAuthn passkeys',
      'Row-level database isolation',
      'Compliance scoring dashboard',
      'Tamper-evident audit log',
    ],
  },
]

const useCasesJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: 'DeskOS Use Cases',
  description: 'See how MSPs, internal IT teams, education, healthcare, SaaS companies, and security-conscious organizations use DeskOS.',
  about: {
    '@type': 'SoftwareApplication',
    name: 'DeskOS',
    applicationCategory: 'BusinessApplication',
  },
}

export default function UseCasesPage() {
  return (
    <LandingLayout
      title="Use Cases — DeskOS | Who Uses DeskOS"
      description="See how MSPs, internal IT teams, education, healthcare, SaaS companies, and security-conscious organizations use DeskOS for remote support and IT management."
      structuredData={useCasesJsonLd}
    >
      {/* hero */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Use Cases</span>
          <h1 className="landing-title">Who uses DeskOS?</h1>
          <p className="landing-sub">
            From a 3-person MSP managing customer tenants to a 500-device enterprise fleet — DeskOS scales with you.
          </p>
          <div className="landing-cta">
            <Link className="btn btn-primary" to="/signup">Start for free</Link>
            <Link className="btn btn-ghost" to="/features">See features</Link>
          </div>
        </div>
      </section>

      {/* use case sections */}
      {USE_CASES.map((uc, i) => (
        <section
          key={uc.title}
          className={`landing-section${i % 2 === 0 ? '' : ' alt'}`}
        >
          <div className="use-case-layout">
            <div className="use-case-text">
              <span className="landing-feature-icon" aria-hidden="true">{uc.icon}</span>
              <span className="landing-kicker">{uc.subtitle}</span>
              <h2 className="landing-h2">{uc.title}</h2>
              <p className="landing-section-sub">{uc.description}</p>
            </div>
            <div className="use-case-checklist">
              {uc.features.map((f) => (
                <div key={f} className="use-case-check">
                  <span className="pricing-check" aria-hidden="true">✓</span>
                  <span>{f}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      {/* comparison */}
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
              {[
                { feature: 'Remote control', deskos: '✅ built-in', tv: '✅ built-in', st: '✅ built-in', ad: '✅ built-in' },
                { feature: 'Endpoint management', deskos: '✅ built-in', tv: '⚠️ separate', st: '⚠️ separate', ad: '❌' },
                { feature: 'ITSM ticketing', deskos: '✅ built-in', tv: '❌', st: '❌', ad: '❌' },
                { feature: 'AI assistant', deskos: '✅ built-in', tv: '❌', st: '❌', ad: '❌' },
                { feature: 'Consent-first', deskos: '✅ enforced', tv: '⚠️', st: '⚠️', ad: '⚠️' },
                { feature: 'Audit log', deskos: '✅ hash-chained', tv: '❌', st: '❌', ad: '❌' },
                { feature: 'Multi-tenant MSP', deskos: '✅ first-class', tv: '⚠️ add-on', st: '❌', ad: '❌' },
                { feature: 'Self-hosted option', deskos: '✅ Docker', tv: '❌', st: '❌', ad: '❌' },
              ].map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td className="mono">{row.deskos}</td>
                  <td className="mono">{row.tv}</td>
                  <td className="mono">{row.st}</td>
                  <td className="mono">{row.ad}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* CTA */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">See how DeskOS fits your team.</h2>
        <p className="landing-sub">
          Create your workspace in under a minute — no sales call, no credit card.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup">Create your workspace</Link>
          <Link className="btn btn-ghost" to="/pricing">View pricing</Link>
        </div>
      </section>
    </LandingLayout>
  )
}
