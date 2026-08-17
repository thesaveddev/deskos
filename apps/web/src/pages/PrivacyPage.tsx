import LandingLayout from '../components/LandingLayout'

export default function PrivacyPage() {
  return (
    <LandingLayout
      title="Privacy Policy — DeskOS"
      description="DeskOS Privacy Policy — how we collect, use, protect, and share your data. GDPR and UK GDPR compliant."
    >
      <section className="landing-section legal-page">
        <div className="legal-content">
          <h1>Privacy Policy</h1>
          <p className="legal-updated">Last updated: August 2026</p>

          <h2>1. Introduction</h2>
          <p>
            DeskOS ("we", "us", "our") is an IT support platform operated by Clean IT Ltd. This Privacy Policy explains how we collect, use, protect, and share information when you use our website, console, and services ("Service").
          </p>
          <p>
            By using the Service you agree to this policy. If you do not agree, please do not use the Service.
          </p>

          <h2>2. Data we collect</h2>
          <h3>2.1 Account information</h3>
          <p>When you create an account we collect your name, email address, organisation name, and password (stored as a bcrypt hash). If you enable MFA we store a TOTP secret and/or WebAuthn credential identifiers.</p>

          <h3>2.2 Remote session data</h3>
          <p>During a remote support session we transmit screen, audio, and input data between the technician and the managed device using end-to-end encrypted WebRTC media. We do not record or store session content unless you explicitly enable video recording for that session type.</p>

          <h3>2.3 Endpoint data</h3>
          <p>The agent reports device metadata (hostname, OS, hardware, installed applications, security posture, and CPU/memory/disk telemetry) for inventory and health monitoring purposes.</p>

          <h3>2.4 Audit logs</h3>
          <p>We maintain a hash-chained, tamper-evident audit log of all significant actions (authentication, remote connections, file operations, permission changes, ticket modifications). Audit logs are retained for the duration of your account and can be exported via the Compliance page.</p>

          <h3>2.5 Usage data</h3>
          <p>We collect anonymised usage analytics (page views, feature adoption, error rates) to improve the Service. This data is not linked to your personal identity.</p>

          <h2>3. How we use your data</h2>
          <ul>
            <li>To provide and operate the Service (authentication, remote sessions, ticketing, notifications).</li>
            <li>To send Service-related emails (password resets, security alerts, membership invites).</li>
            <li>To improve the Service through aggregated, anonymised analytics.</li>
            <li>To comply with legal obligations (audit records, billing).</li>
          </ul>

          <h2>4. Data storage and security</h2>
          <p>
            All data is stored in encrypted PostgreSQL databases with row-level tenant isolation. Remote sessions use end-to-end DTLS-SRTP encryption. Files at rest use AES-256-GCM encryption. We use TLS 1.2+ for all data in transit. Audit logs are hash-chained to detect tampering.
          </p>

          <h2>5. Data sharing</h2>
          <p>We do not sell, rent, or share your personal data with third parties except:</p>
          <ul>
            <li>With your explicit consent.</li>
            <li>To comply with a legal obligation or lawful request.</li>
            <li>To protect the rights, property, or safety of DeskOS, our users, or the public.</li>
          </ul>

          <h2>6. Data residency</h2>
          <p>
            Data is stored on servers in the United Kingdom. We do not transfer data outside the UK/EEA unless you explicitly configure a different deployment region. Enterprise customers may request on-premises deployment.
          </p>

          <h2>7. Your rights</h2>
          <p>Under GDPR and UK GDPR you have the right to:</p>
          <ul>
            <li>Access a copy of your personal data.</li>
            <li>Rectify inaccurate data.</li>
            <li>Request deletion of your data ("right to be forgotten").</li>
            <li>Restrict or object to processing.</li>
            <li>Data portability — export your data in a machine-readable format.</li>
          </ul>
          <p>To exercise these rights, contact us at <a href="mailto:privacy@deskos.com">privacy@deskos.com</a>.</p>

          <h2>8. Data retention</h2>
          <ul>
            <li>Account data: retained while your account is active, deleted within 30 days of account closure.</li>
            <li>Audit logs: retained for the account lifetime, exported on closure.</li>
            <li>Session recordings: retained for the configured retention period (default 30 days), then purged.</li>
            <li>Backup data: purged within 90 days of deletion.</li>
          </ul>

          <h2>9. Cookies</h2>
          <p>
            DeskOS uses only strictly necessary cookies: a session token for authentication and a preference cookie for your active tenant. We do not use tracking cookies or third-party analytics scripts.
          </p>

          <h2>10. Changes to this policy</h2>
          <p>We may update this policy from time to time. Material changes will be notified via email or in-app notification. Continued use of the Service after changes constitutes acceptance.</p>

          <h2>11. Contact</h2>
          <p>
            Data Protection Officer<br />
            Clean IT Ltd<br />
            <a href="mailto:privacy@deskos.com">privacy@deskos.com</a>
          </p>
        </div>
      </section>
    </LandingLayout>
  )
}
