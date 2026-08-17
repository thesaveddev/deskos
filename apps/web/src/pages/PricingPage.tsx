import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

const PLANS = [
  {
    name: 'Starter',
    tag: 'For small teams',
    price: '$29',
    period: '/tech/month',
    billed: 'billed annually',
    desc: 'Everything a small IT team needs to get started with remote support and basic endpoint management.',
    cta: 'Start for free',
    ctaStyle: 'btn btn-ghost btn-block',
    features: [
      { text: 'Up to 3 technicians', included: true },
      { text: '100 managed devices', included: true },
      { text: 'Remote support (attended & unattended)', included: true },
      { text: 'Basic endpoint inventory', included: true },
      { text: 'Ticketing with SLA tracking', included: true },
      { text: 'Knowledge base', included: true },
      { text: 'Customer self-service portal', included: true },
      { text: 'Web Push notifications', included: true },
      { text: 'Email support', included: true },
      { text: 'AI assistant', included: false },
      { text: 'Advanced RMM & DEX', included: false },
      { text: 'Multi-tenant MSP', included: false },
    ],
  },
  {
    name: 'Pro',
    tag: 'Most popular',
    price: '$79',
    period: '/tech/month',
    billed: 'billed annually',
    desc: 'Full ITSM, AI, and RMM for growing teams that need compliance, automation, and enterprise features.',
    highlighted: true,
    cta: 'Start for free',
    ctaStyle: 'btn btn-primary btn-block',
    features: [
      { text: 'Unlimited technicians', included: true },
      { text: '500 managed devices', included: true },
      { text: 'Everything in Starter', included: true },
      { text: 'Full RMM & DEX scoring', included: true },
      { text: 'Security posture evaluation', included: true },
      { text: 'AI assistant + Level-1 agent', included: true },
      { text: 'Patch management', included: true },
      { text: 'Automations & webhooks', included: true },
      { text: 'Service catalogue & approvals', included: true },
      { text: 'Problem & change management', included: true },
      { text: 'Session recording', included: true },
      { text: 'Priority email + chat support', included: true },
    ],
  },
  {
    name: 'Enterprise',
    tag: 'For MSPs & large orgs',
    price: 'Custom',
    period: '',
    billed: 'volume pricing available',
    desc: 'Multi-tenant MSP, SSO, on-premises deployment, dedicated support, and custom SLAs for large organizations.',
    cta: 'Contact sales',
    ctaStyle: 'btn btn-ghost btn-block',
    features: [
      { text: 'Unlimited everything', included: true },
      { text: 'Everything in Pro', included: true },
      { text: 'Multi-tenant MSP console', included: true },
      { text: 'Cross-tenant management', included: true },
      { text: 'SAML SSO + SCIM provisioning', included: true },
      { text: 'On-premises deployment option', included: true },
      { text: 'JIT privileged access', included: true },
      { text: 'Major incident command', included: true },
      { text: 'Compliance scoring dashboard', included: true },
      { text: 'Developer marketplace', included: true },
      { text: 'OAuth2 + OpenAPI', included: true },
      { text: 'Dedicated support engineer', included: true },
    ],
  },
]

const FAQ = [
  {
    q: 'Is there a free trial?',
    a: 'Yes. Every plan starts with a free tier for up to 3 technicians and 100 devices. No credit card required. Upgrade when you need more.',
  },
  {
    q: 'What happens after the free tier?',
    a: 'The Starter plan begins at $29/tech/month (billed annually). You can upgrade or downgrade at any time.',
  },
  {
    q: 'Can I switch plans later?',
    a: 'Yes. Upgrade instantly — you pay the prorated difference. Downgrade takes effect at your next billing cycle.',
  },
  {
    q: 'Do you offer monthly billing?',
    a: 'Annual billing saves 20%. Monthly billing is available at a slightly higher rate — contact us for details.',
  },
  {
    q: 'What is a "technician"?',
    a: 'A technician is any user who initiates remote sessions or works tickets. Endpoint users (the people receiving support) are not counted.',
  },
  {
    q: 'Is there a discount for education or non-profits?',
    a: 'Yes. We offer special pricing for educational institutions and registered non-profit organizations. Contact sales@deskos.com.',
  },
  {
    q: 'Can I self-host DeskOS?',
    a: 'Yes. DeskOS ships with a Dockerfile and docker-compose. Run it on your own VPS or on-premises server. Self-hosted pricing is the same as cloud.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'Visa, Mastercard, American Express, and wire transfer for Enterprise plans.',
  },
]

const COMPARE_ROWS = [
  { feature: 'Technicians', starter: 'Up to 3', pro: 'Unlimited', enterprise: 'Unlimited' },
  { feature: 'Managed devices', starter: '100', pro: '500', enterprise: 'Unlimited' },
  { feature: 'Remote support', starter: '✅', pro: '✅', enterprise: '✅' },
  { feature: 'Endpoint inventory', starter: 'Basic', pro: 'Full + DEX', enterprise: 'Full + DEX' },
  { feature: 'Ticketing with SLA', starter: '✅', pro: '✅', enterprise: '✅' },
  { feature: 'Knowledge base', starter: '✅', pro: '✅ + AI draft', enterprise: '✅ + AI draft' },
  { feature: 'Customer portal', starter: '✅', pro: '✅', enterprise: '✅ custom' },
  { feature: 'AI assistant', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Level-1 AI agent', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'RMM & DEX scoring', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Security posture', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Patch management', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Automations', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Service catalogue', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Problem & change mgmt', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Session recording', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Multi-tenant MSP', starter: '—', pro: '—', enterprise: '✅' },
  { feature: 'SAML SSO', starter: '—', pro: '—', enterprise: '✅' },
  { feature: 'On-premises deployment', starter: '—', pro: '—', enterprise: '✅' },
  { feature: 'JIT privileged access', starter: '—', pro: '—', enterprise: '✅' },
  { feature: 'Compliance scoring', starter: '—', pro: '—', enterprise: '✅' },
  { feature: 'Developer marketplace', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'OAuth2 + OpenAPI', starter: '—', pro: '✅', enterprise: '✅' },
  { feature: 'Support', starter: 'Email', pro: 'Priority email + chat', enterprise: 'Dedicated engineer' },
]

export default function PricingPage() {
  return (
    <LandingLayout
      title="Pricing — DeskOS | IT Support OS Plans"
      description="Simple, transparent pricing for DeskOS. Start free for up to 3 technicians. Pro plan from $79/tech/month. Enterprise with custom pricing."
    >
      {/* hero */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Pricing</span>
          <h1 className="landing-title">Simple, transparent pricing.</h1>
          <p className="landing-sub">
            Start free for up to 3 technicians. Scale to unlimited with the Pro plan. Enterprise pricing for MSPs and large organizations.
          </p>
        </div>
      </section>

      {/* pricing cards */}
      <section className="landing-section" style={{ paddingTop: 0 }}>
        <div className="pricing-grid">
          {PLANS.map((plan) => (
            <article
              key={plan.name}
              className={`pricing-card${plan.highlighted ? ' highlighted' : ''}`}
            >
              {plan.highlighted && <span className="pricing-badge">Most popular</span>}
              <span className="etch">{plan.tag}</span>
              <h3 className="pricing-name">{plan.name}</h3>
              <div className="pricing-price">
                <span className="pricing-amount">{plan.price}</span>
                {plan.period && <span className="pricing-sub">{plan.period}</span>}
              </div>
              <span className="pricing-sub">{plan.billed}</span>
              <p className="pricing-desc">{plan.desc}</p>
              <ul className="pricing-features">
                {plan.features.map((f) => (
                  <li key={f.text}>
                    <span className="pricing-check" aria-hidden="true">
                      {f.included ? '✓' : '—'}
                    </span>
                    <span style={{ color: f.included ? undefined : 'var(--text-3)' }}>
                      {f.text}
                    </span>
                  </li>
                ))}
              </ul>
              <Link className={plan.ctaStyle} to={plan.cta === 'Contact sales' ? '/about' : '/signup'}>
                {plan.cta}
              </Link>
            </article>
          ))}
        </div>
      </section>

      {/* feature comparison table */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Compare plans</span>
          <h2 className="landing-h2">Full feature comparison.</h2>
        </div>
        <div className="landing-table-wrap">
          <table className="comparison-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Starter</th>
                <th>Pro</th>
                <th>Enterprise</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_ROWS.map((row) => (
                <tr key={row.feature}>
                  <td>{row.feature}</td>
                  <td className="mono">{row.starter}</td>
                  <td className="mono">{row.pro}</td>
                  <td className="mono">{row.enterprise}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section className="landing-section" id="faq">
        <div className="landing-section-head">
          <span className="landing-kicker">Questions</span>
          <h2 className="landing-h2">Pricing FAQ.</h2>
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

      {/* CTA */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">Ready to get started?</h2>
        <p className="landing-sub">
          Create your workspace in under a minute — no sales call, no credit card, no install.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup">Start for free</Link>
        </div>
      </section>
    </LandingLayout>
  )
}
