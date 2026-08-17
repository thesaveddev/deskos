import { Link } from 'react-router-dom'
import { useEffect } from 'react'

const PLANS = [
  {
    name: 'Starter',
    price: 'Free',
    priceSub: 'up to 3 technicians',
    description: 'For small teams getting started with remote support.',
    features: [
      'Remote control (attended & unattended)',
      'Up to 100 managed devices',
      'Ticketing with SLA',
      'Knowledge base',
      'Web Push notifications',
      'Customer portal',
      'Up to 3 technicians',
    ],
    cta: 'Start for free',
    ctaTo: '/signup',
    highlighted: false,
  },
  {
    name: 'Business',
    price: '$49',
    priceSub: 'per technician / month',
    description: 'For growing IT teams that need endpoint management and automation.',
    features: [
      'Everything in Starter',
      'Unlimited devices',
      'RMM & DEX health scores',
      'Endpoint policies & bulk actions',
      'Patch management',
      'AI assistant & Level-1 agent',
      'Webhooks (Slack, Teams)',
      'Service catalogue & approvals',
      'Up to 25 technicians',
    ],
    cta: 'Start 14-day trial',
    ctaTo: '/signup',
    highlighted: true,
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    priceSub: 'volume discounts available',
    description: 'For MSPs, large IT departments, and organisations with compliance needs.',
    features: [
      'Everything in Business',
      'Entra/M365 & Active Directory',
      'Major incident command centre',
      'JIT privileged access',
      'OAuth2 public API & developer portal',
      'Compliance dashboards & CSV export',
      'Multi-tenant MSP console',
      'Unlimited technicians',
      'Self-hosted / on-prem deployment',
    ],
    cta: 'Contact sales',
    ctaTo: '/about',
    highlighted: false,
  },
]

export default function PricingPage() {
  useEffect(() => {
    document.title = 'Pricing — DeskOS'
    const meta = (name: string, content: string) => {
      let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null
      if (!el) { el = document.createElement('meta'); el.setAttribute('name', name); document.head.appendChild(el) }
      el.setAttribute('content', content)
    }
    meta('description', 'DeskOS pricing — free for up to 3 technicians, $49/tech/month for Business, custom Enterprise plans with volume discounts.')
    return () => { document.title = 'DeskOS' }
  }, [])

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Link className="brand" to="/" style={{ textDecoration: 'none' }}>DeskOS</Link>
          <span className="etch">IT SUPPORT OS</span>
          <div className="landing-nav-spacer" />
          <a className="landing-nav-link" href="/">Home</a>
          <a className="landing-nav-link" href="/#features">Features</a>
          <a className="landing-nav-link" href="/pricing">Pricing</a>
          <Link className="btn btn-ghost btn-sm" to="/login">Sign in</Link>
          <Link className="btn btn-primary btn-sm" to="/signup">Get started</Link>
        </div>
      </header>

      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Pricing</span>
          <h1 className="landing-title">Simple, honest pricing.</h1>
          <p className="landing-sub">
            Start free. Pay only when you need more technicians. All plans include remote support, ticketing, and a knowledge base.
          </p>
        </div>
      </section>

      <section className="landing-section" style={{ paddingTop: 0 }}>
        <div className="pricing-grid">
          {PLANS.map((plan) => (
            <article key={plan.name} className={`pricing-card${plan.highlighted ? ' highlighted' : ''}`}>
              {plan.highlighted ? <span className="pricing-badge">Most popular</span> : null}
              <h3 className="pricing-name">{plan.name}</h3>
              <div className="pricing-price">
                <span className="pricing-amount">{plan.price}</span>
                <span className="pricing-sub">{plan.priceSub}</span>
              </div>
              <p className="pricing-desc">{plan.description}</p>
              <ul className="pricing-features">
                {plan.features.map((f) => (
                  <li key={f}><span className="pricing-check">✓</span> {f}</li>
                ))}
              </ul>
              <Link className={`btn ${plan.highlighted ? 'btn-primary' : 'btn-ghost'} btn-block`} to={plan.ctaTo}>
                {plan.cta}
              </Link>
            </article>
          ))}
        </div>
        <p className="muted" style={{ textAlign: 'center', marginTop: 24, fontSize: 13 }}>
          All plans include end-to-end encrypted remote sessions, hash-chained audit logs, and consent-first security. No hidden fees.
        </p>
      </section>

      <section className="landing-cta-band">
        <h2 className="landing-h2">Questions about pricing?</h2>
        <p className="landing-sub">We're happy to help you find the right plan.</p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/about">Contact us</Link>
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
