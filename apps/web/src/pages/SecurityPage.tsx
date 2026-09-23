import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'

export default function SecurityPage() {
  return (
    <LandingLayout
      title="Security & Trust — ReyDesk"
      description="How ReyDesk protects your data: tenant isolation, tamper-evident audit logging, consent-first remote support, MFA, daily backups, and an honest SSO status."
    >
      <section className="landing-section legal-page">
        <div className="legal-content">
          <h1>Security &amp; Trust</h1>
          <p className="legal-updated">Last updated: 23 September 2026</p>

          <p>
            This page answers the security questions organisations ask before deploying ReyDesk.
            ReyDesk is operated by 34orients Ltd and hosted at reydesk.com. Where something is not
            yet in place we say so rather than imply otherwise — if you need detail for a
            questionnaire or procurement process, <Link to="/contact">contact us</Link> and we will
            respond.
          </p>

          <h2>Data isolation</h2>
          <ul>
            <li>
              Every table carrying tenant data uses PostgreSQL row-level security, enforced at the
              database layer — even a query that somehow skipped our permission checks cannot read
              another tenant's rows.
            </li>
            <li>
              Access tokens carry the tenant claim, and the API resolves every request against a
              single active tenant context.
            </li>
            <li>
              Remote-support codes are tenant-scoped, expire automatically within 24 hours, and
              cannot be redeemed across tenants.
            </li>
          </ul>

          <h2>Identity and access</h2>
          <ul>
            <li>Password login with optional TOTP two-factor authentication and recovery codes.</li>
            <li>WebAuthn passkeys and email magic links as passwordless alternatives.</li>
            <li>An automatic lock screen when the console is left idle.</li>
            <li>
              Role-based access control: every API route is permission-gated by organisation role,
              and membership changes are audit logged.
            </li>
          </ul>

          <h2>Single sign-on and provisioning status</h2>
          <p>
            Today ReyDesk supports passwords (with MFA), passkeys, and magic links. SAML 2.0 single
            sign-on and SCIM provisioning are on our roadmap, targeted at the Enterprise tier — we
            will not claim support before it exists. If SAML or SCIM is a hard requirement for your
            evaluation, tell us via the contact page and we will share the current status.
          </p>

          <h2>Audit trail</h2>
          <ul>
            <li>
              Authentication, ticket, session, billing, and administrative actions are written to an
              append-only, hash-chained audit log.
            </li>
            <li>
              The chain is verifiable through a built-in integrity check, so tampering with
              historical entries is detectable.
            </li>
            <li>Audit history is exportable as CSV for your own records.</li>
          </ul>

          <h2>Remote support and consent</h2>
          <ul>
            <li>
              Every support session begins with an approval screen on the supported device, listing
              exactly which capabilities are requested: screen, mouse and keyboard, clipboard, file
              transfer, elevated terminal, and service management.
            </li>
            <li>
              The device user can decline, grant a subset of permissions, and end access at any
              time from the same screen.
            </li>
            <li>Elevated administrator actions are requested and recorded separately from the base session.</li>
            <li>Session events are recorded to the same tamper-evident audit trail.</li>
          </ul>

          <h2>AI workers and governance</h2>
          <ul>
            <li>
              Each AI playbook runs under its own machine identity with a reviewed, least-privilege
              tool scope.
            </li>
            <li>High-risk actions require human approval; every tool call is permission-checked and logged.</li>
            <li>
              AI providers are configured per tenant — bring your own provider and key; your
              tickets are not routed through a shared model account.
            </li>
          </ul>

          <h2>Encryption and transport</h2>
          <ul>
            <li>
              All traffic is served over TLS 1.2 or newer (TLS 1.3 preferred) with HTTP Strict
              Transport Security enforced.
            </li>
            <li>
              Database and object-storage encryption at rest is provided by our hosting
              environment; ask us for the specifics relevant to your procurement checklist.
            </li>
          </ul>

          <h2>Backups and infrastructure</h2>
          <ul>
            <li>
              The production database is backed up automatically every day with 30 days of
              retention, and each run is verified non-empty before it is kept.
            </li>
            <li>
              SSH access to production servers is protected by automated brute-force banning, and
              container logs are rotated on a fixed retention policy.
            </li>
            <li>
              Deploys run through a CI pipeline that requires typecheck, lint, a full API test
              suite, and end-to-end browser tests before anything reaches production.
            </li>
          </ul>

          <h2>Vulnerability reporting</h2>
          <p>
            If you believe you have found a security issue in ReyDesk, please report it through our{' '}
            <Link to="/contact">contact page</Link> with the subject "Security" rather than
            publishing it publicly. We will acknowledge the report, investigate, and work with you
            on remediation and disclosure timing.
          </p>

          <h2>Data handling</h2>
          <p>
            You own your data. We do not sell it or use it for advertising. Following termination,
            data is retained for 30 days to allow export and then deleted, as described in our{' '}
            <Link to="/terms">Terms of Service</Link> and <Link to="/privacy">Privacy Policy</Link>.
          </p>
        </div>
      </section>
    </LandingLayout>
  )
}
