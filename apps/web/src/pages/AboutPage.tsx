import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

export default function AboutPage() {
  return (
    <LandingLayout
      title="About — ReyDesk"
      description="ReyDesk is built by 34orients Ltd. One app for remote support, device management, and IT tickets."
    >
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">About</span>
          <h1 className="landing-title">Why we built this.</h1>
          <p className="landing-sub">
            We kept buying separate tools for remote support, ticketing, and monitoring. It was expensive, messy, and nothing talked to each other. So we built one app that does all three.
          </p>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">The problem we ran into</h2>
        </div>
        <div className="legal-content">
          <p>
            We were running a small IT operation. We had one tool for remote desktop access, another for tickets, another for monitoring devices. Every tool had its own login, its own subscription, its own way of storing data.
          </p>
          <p>
            When something broke, we had to piece together what happened from three different audit logs. When a remote session went wrong, there was no record of who approved it. When we needed to show an auditor what we did, we had to export CSVs from three systems and hope they lined up.
          </p>
          <p>
            We looked at the existing options. The remote desktop tools were good at remote desktop but had no ticketing. The ticketing tools had no device monitoring. The monitoring tools had no remote access. And none of them had a proper audit trail.
          </p>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">What we built</h2>
        </div>
        <div className="legal-content">
          <p>
            ReyDesk is one application that handles remote support, endpoint monitoring, and IT ticketing. Everything shares the same database. A remote session is linked to a ticket. A device alert can auto-create a ticket. The audit log records everything across all three.
          </p>
          <p>
            The design principles were straightforward:
          </p>
          <ul>
            <li><strong>Consent is mandatory.</strong> No remote session can start without the endpoint user clicking "Allow." This is enforced in the agent code, not just the UI.</li>
            <li><strong>The audit log is tamper-evident.</strong> Each entry includes a hash of the previous entry. You can verify the chain hasn't been broken.</li>
            <li><strong>Self-hostable.</strong> Run it on your own server with Docker. We don't need to see your data.</li>
            <li><strong>No vendor lock-in.</strong> The API is documented. The database is PostgreSQL. You can export everything.</li>
          </ul>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">Where we are now</h2>
        </div>
        <div className="landing-features" style={{ maxWidth: 720, margin: '0 auto' }}>
          <article className="landing-feature">
            <h3>39 migrations</h3>
            <p>The schema is versioned. Every change is tracked. We don't make breaking changes without a migration.</p>
          </article>
          <article className="landing-feature">
            <h3>365 API tests</h3>
            <p>Every endpoint has tests. CI runs them on every push. If a test breaks, we don't merge.</p>
          </article>
          <article className="landing-feature">
            <h3>Open source</h3>
            <p>The code is on GitHub. You can read it, fork it, run it yourself. No black boxes.</p>
          </article>
        </div>
      </section>

      <section className="landing-section">
        <div className="landing-section-head">
          <h2 className="landing-h2">Who we are</h2>
        </div>
        <div className="legal-content">
          <p>
            ReyDesk is built by <strong><a href="https://34orients.com" target="_blank" rel="noreferrer">34orients Ltd</a></strong>, a small UK-based company. We build IT tools because we've used bad IT tools and we think things can be better.
          </p>
          <p>
            We're not a 500-person company. We're a small team writing code we'd want to use ourselves. If you have feedback, email us at <a href="mailto:hello@reydesk.com">hello@reydesk.com</a> — we read every message.
          </p>
        </div>
      </section>

      <section className="landing-cta-band">
        <h2 className="landing-h2">Want to try it?</h2>
        <p className="landing-sub">
          Create a workspace. Takes about a minute. No credit card.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup">Get started</Link>
          <Link className="btn btn-ghost" to="/contact">Contact us</Link>
        </div>
      </section>
    </LandingLayout>
  )
}
