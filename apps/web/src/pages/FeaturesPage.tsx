import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'
import { Icon, type IconName } from '../components/Icons'

type Feature = { icon: IconName; title: string; body: string }

const REMOTE_FEATURES: Feature[] = [
  {
    icon: 'monitor',
    title: 'Attended & unattended access',
    body: 'Connect to any device with a one-time code (no pre-install needed) or roll out agents silently for always-on unattended access.',
  },
  {
    icon: 'shield',
    title: 'Consent-first by design',
    body: 'Every session requires explicit user consent — enforced at the protocol level. Consent events are hash-chained in the audit log.',
  },
  {
    icon: 'keyboard',
    title: 'Full input control',
    body: 'Keyboard, mouse, multi-monitor support, clipboard sync, and file transfer — all end-to-end encrypted over WebRTC.',
  },
  {
    icon: 'chat',
    title: 'In-session chat',
    body: 'Built-in text chat during remote sessions. Technicians and endpoint users communicate without switching tools.',
  },
  {
    icon: 'folder',
    title: 'File manager',
    body: 'Browse, upload, download, and transfer files between technician and endpoint during any remote session.',
  },
  {
    icon: 'terminal',
    title: 'Terminal access',
    body: 'Remote shell access for command-line troubleshooting — no separate SSH tool required.',
  },
]

const RMM_FEATURES: Feature[] = [
  {
    icon: 'database',
    title: 'Structured inventory',
    body: 'CPU, memory, disk, network, OS, installed software — collected on every telemetry sample and queryable across your fleet.',
  },
  {
    icon: 'activity',
    title: 'DEX health scoring',
    body: 'Device Experience scores combine CPU, memory, disk, and uptime into a single 0–100 score per endpoint.',
  },
  {
    icon: 'shield',
    title: 'Security posture',
    body: 'Evaluate disk encryption, firewall, and antivirus status on every device. Non-compliant devices get flagged automatically.',
  },
  {
    icon: 'package',
    title: 'Patch management',
    body: 'Track OS and third-party patch status across your fleet. Ring-based rollout with approval workflows.',
  },
  {
    icon: 'settings',
    title: 'Device groups & policies',
    body: 'Organize devices into groups and apply policies at scale — bulk actions, dynamic grouping, and group-level overrides.',
  },
  {
    icon: 'bell',
    title: 'Real-time alerts',
    body: 'Custom alert rules evaluate agent metrics and trigger device alerts, auto-create tickets, or send notifications.',
  },
]

const ITSM_FEATURES: Feature[] = [
  {
    icon: 'ticket',
    title: 'Ticketing with SLA',
    body: 'Full ticket lifecycle with business-hours SLA math, priorities, assignments, canned responses, and customer portal.',
  },
  {
    icon: 'box',
    title: 'Service catalogue',
    body: 'Offer structured request forms with approval workflows. Employees request services; managers approve; technicians fulfil.',
  },
  {
    icon: 'refresh',
    title: 'Problem & change management',
    body: 'Track root causes across incidents (Problem) and manage planned changes with risk assessment and CAB approval (Change).',
  },
  {
    icon: 'flag',
    title: 'Major incident command',
    body: 'Declare a major incident, assemble a war room, track action items, and communicate status updates to stakeholders.',
  },
  {
    icon: 'book',
    title: 'Knowledge base',
    body: 'Technician-authored articles with categories, tags, search, and AI-assisted drafting from resolved tickets.',
  },
  {
    icon: 'sparkles',
    title: 'Automations',
    body: 'If-this-then-that rules: auto-assign tickets, escalate on SLA breach, notify on device alerts, create tickets from events.',
  },
]

const AI_FEATURES: Feature[] = [
  {
    icon: 'sparkles',
    title: 'Ticket summaries',
    body: 'AI generates concise summaries of long ticket threads so new technicians can get up to speed in seconds.',
  },
  {
    icon: 'search',
    title: 'Similar-incident detection',
    body: 'When a new ticket arrives, AI suggests historically similar incidents and their resolutions.',
  },
  {
    icon: 'edit',
    title: 'KB article drafting',
    body: 'AI drafts knowledge base articles from resolved tickets. Technicians review and publish — no blank-page problem.',
  },
  {
    icon: 'wrench',
    title: 'Level-1 bounded agent',
    body: 'An AI agent proposes bounded remediations (restart, collect inventory, add notes). Nothing runs until a human approves.',
  },
]

const SECURITY_FEATURES: Feature[] = [
  {
    icon: 'lock',
    title: 'Row-level tenant isolation',
    body: 'Every database table uses PostgreSQL Row-Level Security. One tenant literally cannot see another tenant\'s data.',
  },
  {
    icon: 'link',
    title: 'Hash-chained audit log',
    body: 'Every action is recorded in a tamper-evident, hash-chained audit log. Provable compliance for any auditor.',
  },
  {
    icon: 'key',
    title: 'JIT privileged access',
    body: 'Just-in-time access with checkout/check-in, time-boxed elevation, and full audit trail. No standing admin rights.',
  },
  {
    icon: 'user',
    title: 'MFA + passkeys',
    body: 'TOTP, WebAuthn passkeys, and backup codes. Support for hardware security keys and biometric authentication.',
  },
  {
    icon: 'eye',
    title: 'Session recording',
    body: 'Remote sessions can be recorded for training, compliance, and dispute resolution. Recordings are encrypted at rest.',
  },
  {
    icon: 'check',
    title: 'Compliance scoring',
    body: 'Continuous compliance evaluation against your defined policies. Per-device scores and organization-wide dashboards.',
  },
]

const INTEGRATION_FEATURES: Feature[] = [
  {
    icon: 'building',
    title: 'Entra ID & M365 sync',
    body: 'Sync users, groups, and devices from Microsoft Entra ID. Single sign-on and group-based access control.',
  },
  {
    icon: 'server',
    title: 'Active Directory',
    body: 'On-premises Active Directory integration for hybrid environments. LDAP sync and Group Policy deployment.',
  },
  {
    icon: 'link',
    title: 'OAuth2 & OpenAPI',
    body: 'Full REST API with OAuth2 authentication and OpenAPI 3.1 specification. Build integrations on day one.',
  },
  {
    icon: 'bell',
    title: 'Web Push notifications',
    body: 'Native push notifications for new tickets, alerts, and session requests — even when the app is closed.',
  },
  {
    icon: 'chat',
    title: 'Slack & Teams webhooks',
    body: 'Send alerts, ticket updates, and notifications to Slack channels or Microsoft Teams.',
  },
  {
    icon: 'plug',
    title: 'Developer marketplace',
    body: 'Install third-party apps or publish your own. App registry with per-tenant install management.',
  },
]

function FeatureSection({
  kicker,
  title,
  subtitle,
  features,
  id,
}: {
  kicker: string
  title: string
  subtitle: string
  features: Feature[]
  id: string
}) {
  return (
    <section className="landing-section" id={id}>
      <div className="landing-section-head">
        <span className="landing-kicker">{kicker}</span>
        <h2 className="landing-h2">{title}</h2>
        <p className="landing-section-sub">{subtitle}</p>
      </div>
      <div className="landing-features">
        {features.map((f) => (
          <article key={f.title} className="landing-feature">
            <span className="landing-feature-icon" aria-hidden="true"><Icon name={f.icon} size={22} /></span>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

const featuresJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'ReyDesk',
  applicationCategory: 'BusinessApplication',
  featureList: [
    'Remote desktop support with end-to-end encryption',
    'Endpoint management and RMM',
    'IT service management with SLA tracking',
    'AI-powered ticket summaries and remediation',
    'Security posture evaluation and compliance',
    'OAuth2 API with OpenAPI 3.1 specification',
    'Multi-tenant MSP console',
    'Web Push notifications',
    'Knowledge base with AI drafting',
    'Patch management with ring rollout',
  ],
  url: 'https://www.reydesk.com/features',
}

export default function FeaturesPage() {
  return (
    <LandingLayout
      title="Features — ReyDesk | Remote Support, RMM & ITSM"
      description="Explore ReyDesk features: remote desktop support, endpoint management, IT ticketing, AI assistant, security compliance, and 50+ integrations."
      structuredData={featuresJsonLd}
    >
      {/* hero */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker">Platform</span>
          <h1 className="landing-title">What ReyDesk does.</h1>
          <p className="landing-sub">
            Remote support, device monitoring, ticketing, AI assistance, security auditing, and integrations. All in one app, sharing one database.
          </p>
          <div className="landing-cta">
            <Link className="btn btn-primary" to="/signup">Start for free</Link>
            <Link className="btn btn-ghost" to="/pricing">View pricing</Link>
          </div>
        </div>
      </section>

      <FeatureSection
        id="remote"
        kicker="Remote Support"
        title="Remote desktop support."
        subtitle="Attended and unattended sessions with end-to-end encryption, consent enforcement, and a portable helper that needs no installation."
        features={REMOTE_FEATURES}
      />

      <FeatureSection
        id="rmm"
        kicker="Endpoint Management"
        title="Know your fleet before things break."
        subtitle="Structured inventory, DEX health scores, security posture evaluation, patch tracking, and real-time alerting across every device."
        features={RMM_FEATURES}
      />

      <FeatureSection
        id="itsm"
        kicker="IT Service Management"
        title="Ticketing that actually helps."
        subtitle="SLA tracking, service catalogue, problem & change management, major incident command, knowledge base, and automations."
        features={ITSM_FEATURES}
      />

      <FeatureSection
        id="ai"
        kicker="AI Assistant"
        title="AI that proposes. Humans decide."
        subtitle="Ticket summaries, similar-incident detection, KB drafting, and a bounded Level-1 agent — nothing runs without human approval."
        features={AI_FEATURES}
      />

      <FeatureSection
        id="security"
        kicker="Security & Compliance"
        title="Built for auditors."
        subtitle="Row-level tenant isolation, hash-chained audit logs, JIT privileged access, MFA + passkeys, session recording, and compliance scoring."
        features={SECURITY_FEATURES}
      />

      <FeatureSection
        id="integrations"
        kicker="Integrations"
        title="Plays well with your stack."
        subtitle="Entra ID, Active Directory, OAuth2, OpenAPI, Web Push, Slack, Teams, and a developer marketplace."
        features={INTEGRATION_FEATURES}
      />

      {/* deployment options */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Deployment</span>
          <h2 className="landing-h2">Three ways to connect a device.</h2>
          <p className="landing-section-sub">
            From a single ad-hoc support code to a fleet-wide Group Policy rollout — ReyDesk meets you where you are.
          </p>
        </div>
        <div className="landing-deploys">
          <article className="landing-deploy">
            <span className="etch">Customer-assisted</span>
            <h3>Send the MSI and a code</h3>
            <p>The user installs the agent, opens Enroll ReyDesk Agent, and enters one 8-digit code. No terminal, no credentials.</p>
          </article>
          <article className="landing-deploy">
            <span className="etch">Technician-assisted</span>
            <h3>Guide them live</h3>
            <p>Generate a support code during the call. The endpoint user approves consent, and you take control without preinstalled software.</p>
          </article>
          <article className="landing-deploy">
            <span className="etch">IT fleet deployment</span>
            <h3>Roll out at scale</h3>
            <p>Protected MSI properties carry a bootstrap token for Intune, Group Policy, or any endpoint platform — silent, scripted enrolment.</p>
          </article>
        </div>
      </section>

      {/* CTA */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">Ready to see it in action?</h2>
        <p className="landing-sub">
          Create your workspace in under a minute — no sales call, no credit card, no install.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup">Create your workspace</Link>
          <Link className="btn btn-ghost" to="/pricing">View pricing</Link>
        </div>
      </section>
    </LandingLayout>
  )
}
