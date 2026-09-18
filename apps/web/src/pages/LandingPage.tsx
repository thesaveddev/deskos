import { useState } from 'react'
import { Link } from 'react-router-dom'
import LandingLayout from '../components/LandingLayout'
import { Icon, type IconName } from '../components/Icons'

const PROOF_POINTS = [
  { number: 'One', label: 'console for support, tickets, and devices' },
  { number: 'Every', label: 'remote session starts with consent' },
  { number: 'Free', label: 'workspace for up to 3 technicians' },
  { number: 'Built-in', label: 'audit trail for the work you do' },
]

const HIGHLIGHTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'monitor',
    title: 'Remote support',
    body: 'Connect to any Windows machine with a one-time code or roll out agents silently. Screen sharing, keyboard/mouse control, file transfer, clipboard sync — over encrypted WebRTC.',
  },
  {
    icon: 'chart',
    title: 'Endpoint management',
    body: 'CPU, memory, disk, OS, installed software — collected automatically. Device Experience scores flag unhealthy machines before users complain.',
  },
  {
    icon: 'ticket',
    title: 'Ticketing',
    body: 'Tickets with business-hours SLA math, canned responses, a customer portal, and a knowledge base your technicians actually write.',
  },
  {
    icon: 'sparkles',
    title: 'AI that asks before it acts',
    body: 'Summarise long ticket threads, find similar past incidents, draft KB articles. The Level-1 agent proposes fixes — you approve before anything runs.',
  },
  {
    icon: 'shield',
    title: 'Audit log you can trust',
    body: 'Every action — logins, sessions, file operations, ticket changes — recorded in a hash-chained, tamper-evident chain. Export it for auditors.',
  },
  {
    icon: 'plug',
    title: 'Talks to your existing tools',
    body: 'Sync users from Entra ID or Active Directory. Push alerts to Slack. Build on top of the OAuth2 API. Web Push notifications on every browser.',
  },
]

const CAPABILITY_GROUPS: { icon: IconName; eyebrow: string; title: string; body: string; items: string[]; to: string }[] = [
  {
    icon: 'sparkles',
    eyebrow: 'AI workers',
    title: 'Move from AI suggestions to governed work',
    body: 'ReyDesk AI workers can read the ticket, inspect the linked device and knowledge, propose a diagnosis, and take approved actions. Humans remain in control of risky steps.',
    items: ['L1 playbooks for common support issues', 'Confidence scoring and escalation paths', 'Approval gates before tool calls', 'Per-run activity, token, cost, and outcome tracking'],
    to: '/features#ai',
  },
  {
    icon: 'ticket',
    eyebrow: 'ITSM',
    title: 'Run the service desk, not just a ticket list',
    body: 'Give technicians the workflow around the ticket: triage, assignment, SLA clocks, reminders, approvals, escalation, change, problem, and knowledge management.',
    items: ['Queues, priorities, business-hours SLA math', 'Ticket reminders, snooze, forward, and escalation', 'Service catalogue, approvals, and JIT access', 'Linked users, devices, assets, services, and knowledge'],
    to: '/features#itsm',
  },
  {
    icon: 'chart',
    eyebrow: 'RMM and endpoint health',
    title: 'Know which machines need attention before users call',
    body: 'Collect endpoint inventory and health signals in the same system where technicians resolve the work. Turn alerts into context, not another dashboard to monitor.',
    items: ['CPU, memory, disk, OS, software, and check-in state', 'Device alerts and automatic ticket workflows', 'Patches, automations, scripts, and device groups', 'Device Experience scoring and fleet reporting'],
    to: '/features#rmm',
  },
  {
    icon: 'shield',
    eyebrow: 'Trust and governance',
    title: 'Make every action explainable',
    body: 'ReyDesk is designed for support teams that need to know who accessed what, which permissions were granted, and how a resolution was reached.',
    items: ['Consent-first remote support sessions', 'Hash-chained audit history and exports', 'AI activity and data-access logging', 'Tool permissions, approvals, and usage alerts'],
    to: '/features#security',
  },
  {
    icon: 'plug',
    eyebrow: 'Integrations and APIs',
    title: 'Fit the way your team already works',
    body: 'Connect identity, notifications, automation, and external AI clients without making ReyDesk a closed island.',
    items: ['Entra ID and Active Directory sync', 'Webhooks, OAuth2 API, and MCP tools', 'Slack and browser push notifications', 'Tenant-aware integrations and connection tests'],
    to: '/features#integrations',
  },
  {
    icon: 'users',
    eyebrow: 'MSP and ESM operations',
    title: 'Scale from one helpdesk to many workspaces',
    body: 'Support internal teams, customers, or multiple tenants from a consistent operating model with roles, billing, reporting, and a customer portal.',
    items: ['Multi-tenant MSP administration', 'Customer portal and public support routes', 'Teams, roles, permissions, and approvals', 'Reports for workload, SLA, AI, devices, and outcomes'],
    to: '/use-cases',
  },
]

const WALKTHROUGH_STEPS = [
  { label: 'See the signal', title: 'A device alert becomes a ticket', body: 'High CPU, an offline printer, or an SLA risk lands in the same queue your technicians already use.', detail: 'Signal · ticket · SLA context', icon: 'chart' as IconName },
  { label: 'Take the action', title: 'Start a consented remote session', body: 'Open the ticket, share a one-time code, and let the endpoint user approve exactly what the technician can do.', detail: 'One-time code · explicit consent', icon: 'monitor' as IconName },
  { label: 'Leave the record', title: 'Resolve with the context intact', body: 'The resolution note, device state, and session events stay together so the next technician can pick up without guesswork.', detail: 'Resolution · audit trail · knowledge', icon: 'shield' as IconName },
]

const DEPLOYMENTS = [
  {
    tag: 'One-time code',
    title: 'No pre-install needed',
    body: 'User runs a small helper, enters a 12-digit code you give them over the phone. Done.',
  },
  {
    tag: 'Silent install',
    title: 'MSI via Group Policy',
    body: 'Roll out the agent to every machine in your fleet with Intune, GPO, or any endpoint manager.',
  },
  {
    tag: 'Manual',
    title: 'Download and run',
    body: 'User downloads the helper, double-clicks, no account or terminal required.',
  },
]

function ProductWalkthrough() {
  const [activeStep, setActiveStep] = useState(0)
  const step = WALKTHROUGH_STEPS[activeStep]

  return (
    <section className="landing-walkthrough" aria-labelledby="walkthrough-title">
      <div className="landing-walkthrough-copy">
        <span className="landing-kicker">See it in motion</span>
        <h2 className="landing-h2" id="walkthrough-title">One incident. One clear path.</h2>
        <p className="landing-section-sub">Follow the workflow a technician actually uses, from the first device signal to a verified resolution.</p>
        <div className="landing-walkthrough-tabs" role="tablist" aria-label="ReyDesk workflow steps">
          {WALKTHROUGH_STEPS.map((item, index) => (
            <button key={item.label} className={`landing-walkthrough-tab${index === activeStep ? ' active' : ''}`} role="tab" aria-selected={index === activeStep} onClick={() => setActiveStep(index)}>
              <span className="landing-walkthrough-tab-number">0{index + 1}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </div>
        <Link className="landing-walkthrough-guide" to="/features#remote">Open the full feature guide <span aria-hidden="true">→</span></Link>
      </div>
      <div className="landing-walkthrough-stage" role="tabpanel" aria-live="polite">
        <div className="landing-walkthrough-stage-bar"><span className="mono">REYDESK / WORKFLOW</span><span className="landing-walkthrough-live"><i /> live walkthrough</span></div>
        <div className="landing-walkthrough-stage-body">
          <div className="landing-walkthrough-icon"><Icon name={step.icon} size={24} /></div>
          <span className="etch">{step.detail}</span>
          <h3>{step.title}</h3>
          <p>{step.body}</p>
          <div className="landing-walkthrough-progress" aria-hidden="true"><span style={{ width: `${((activeStep + 1) / WALKTHROUGH_STEPS.length) * 100}%` }} /></div>
          <div className="landing-walkthrough-controls"><span>Step {activeStep + 1} of {WALKTHROUGH_STEPS.length}</span><button className="btn btn-ghost btn-sm" onClick={() => setActiveStep((activeStep + 1) % WALKTHROUGH_STEPS.length)}>{activeStep === WALKTHROUGH_STEPS.length - 1 ? 'Replay' : 'Next step'} <span aria-hidden="true">→</span></button></div>
        </div>
      </div>
    </section>
  )
}

export default function LandingPage() {
  return (
    <LandingLayout
      title="ReyDesk — Remote Support, ITSM & Endpoint Management"
      description="Give technicians one console for remote support, ticketing, device health, and governed AI assistance. Start free with no credit card."
    >
      {/* ---- hero ---- */}
      <section className="landing-hero">
        <div className="landing-hero-inner">
          <span className="landing-kicker landing-animate">Remote support · RMM · Ticketing</span>
          <h1 className="landing-title landing-animate landing-animate-delay-1">
            Resolve support work<br />without the tool sprawl.
          </h1>
          <p className="landing-sub landing-animate landing-animate-delay-2">
            ReyDesk brings remote support, ticketing, device health, and governed AI into one technician console. Start with the queue, jump into a consented session, and leave a clear record of the work.
          </p>
          <div className="landing-cta landing-animate landing-animate-delay-3">
            <Link className="btn btn-primary" to="/signup" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
              Start your free workspace
            </Link>
            <Link className="btn btn-ghost" to="/features" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
              See how it works
            </Link>
          </div>
          <p className="landing-sub landing-animate landing-animate-delay-3" style={{ fontSize: 13, marginBottom: 0, marginTop: 12 }}>
            Free for up to 3 technicians. No credit card. Upgrade only when the team needs more.
          </p>
        </div>

        {/* console mockup */}
        <div className="landing-console landing-animate landing-animate-delay-3" aria-hidden="true">
          <div className="landing-console-bar">
            <span className="landing-dot" style={{ background: 'var(--crit)' }} />
            <span className="landing-dot" style={{ background: 'var(--warn)' }} />
            <span className="landing-dot" style={{ background: 'var(--ok)' }} />
            <span className="landing-console-title mono">ReyDesk — illustrative technician console</span>
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

      <ProductWalkthrough />

      {/* ---- proof points ---- */}
      <section className="landing-proof" aria-label="ReyDesk at a glance">
        <div className="landing-proof-grid">
          {PROOF_POINTS.map((point) => (
            <div key={point.label} className="landing-proof-card">
              <strong>{point.number}</strong>
              <span>{point.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ---- features ---- */}
      <section className="landing-section" id="features">
        <div className="landing-section-head">
          <span className="landing-kicker">What it does</span>
          <h2 className="landing-h2">The operating system for support work.</h2>
          <p className="landing-section-sub">
            Remote access, ITSM, endpoint operations, AI workers, governance, and reporting are connected by the same ticket, user, device, asset, and service context.
          </p>
        </div>
        <div className="landing-features">
          {HIGHLIGHTS.map((f) => (
            <article key={f.title} className="landing-feature">
              <span className="landing-feature-icon" aria-hidden="true"><Icon name={f.icon} size={22} /></span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
        <div className="landing-capability-grid">
          {CAPABILITY_GROUPS.map((group) => (
            <article key={group.title} className="landing-capability">
              <div className="landing-capability-head"><span className="landing-feature-icon" aria-hidden="true"><Icon name={group.icon} size={20} /></span><span className="etch">{group.eyebrow}</span></div>
              <h3>{group.title}</h3>
              <p>{group.body}</p>
              <ul>{group.items.map((item) => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul>
              <Link className="landing-capability-link" to={group.to}>Explore {group.eyebrow.toLowerCase()} <span aria-hidden="true">→</span></Link>
            </article>
          ))}
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/features">Full feature list →</Link>
        </div>
      </section>

      <section className="landing-section landing-section-ai" id="ai-workers">
        <div className="landing-ai-layout">
          <div className="landing-ai-copy">
            <span className="landing-kicker">A practical AI layer</span>
            <h2 className="landing-h2">AI workers that do the next step, safely.</h2>
            <p className="landing-section-sub">Most AI support tools stop at a summary. ReyDesk connects diagnosis to controlled action: context first, proposed plan next, approval before impact, verification after.</p>
            <Link className="btn btn-ghost" to="/ai-workers">Explore AI workers →</Link>
          </div>
          <div className="landing-ai-flow" aria-label="AI worker workflow">
            <div><span>01</span><strong>Understand</strong><p>Read the ticket, requester, device, asset, service, and relevant knowledge.</p></div>
            <div><span>02</span><strong>Decide</strong><p>Score confidence, select a playbook, and explain the proposed action.</p></div>
            <div><span>03</span><strong>Act with approval</strong><p>Run permitted tools, record every step, verify the result, or escalate to a human.</p></div>
          </div>
        </div>
      </section>

      {/* ---- retention loop ---- */}
      <section className="landing-section landing-section-alt">
        <div className="landing-section-head">
          <span className="landing-kicker">The daily workflow</span>
          <h2 className="landing-h2">Keep the context after the call ends.</h2>
          <p className="landing-section-sub">
            ReyDesk is useful every day, not only when a customer needs remote control. The same workspace carries work from first alert to verified resolution.
          </p>
        </div>
        <div className="landing-workflow" aria-label="The ReyDesk support workflow">
          <article className="landing-workflow-step">
            <span className="landing-workflow-number">01</span>
            <h3>See the signal</h3>
            <p>Tickets, device alerts, AI recommendations, SLA risk, approvals, and customer replies arrive in one queue.</p>
          </article>
          <article className="landing-workflow-step">
            <span className="landing-workflow-number">02</span>
            <h3>Take the right action</h3>
            <p>Open a consented session, run an approved playbook, patch a device, update knowledge, or route the work to the right team.</p>
          </article>
          <article className="landing-workflow-step">
            <span className="landing-workflow-number">03</span>
            <h3>Leave the record</h3>
            <p>Resolution notes, audit events, AI steps, device context, approvals, and knowledge stay attached to the work.</p>
          </article>
        </div>
      </section>

      {/* ---- use cases ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Who it's for</span>
          <h2 className="landing-h2">If you fix computers for a living, this is for you.</h2>
        </div>
        <div className="landing-use-case-grid">
          <article className="landing-use-case-card">
            <h3>MSPs</h3>
            <p>Manage multiple customer tenants from one view. Each customer sees their own portal. You see everything.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>Internal IT</h3>
            <p>Tickets with SLA tracking, device health monitoring, and a knowledge base. The stuff your helpdesk actually needs.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>SaaS support</h3>
            <p>Customer calls with a problem? Generate a code, they run it, you take over. No pre-install, no account needed on their end.</p>
          </article>
          <article className="landing-use-case-card">
            <h3>Regulated industries</h3>
            <p>Every session logged. Every consent recorded. Hash-chained audit trail. Built for organisations that need to prove what happened.</p>
          </article>
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/use-cases">More use cases →</Link>
        </div>
      </section>

      {/* ---- deployment ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Getting started</span>
          <h2 className="landing-h2">Three ways to connect a device.</h2>
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

      {/* ---- honest pitch ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Why us</span>
          <h2 className="landing-h2">What we think matters.</h2>
        </div>
        <div className="legal-content" style={{ maxWidth: 720, margin: '0 auto' }}>
          <p>
            Most IT teams use three to five tools: a remote control app, a ticketing system, a monitoring platform. Each one has its own login, its own billing, its own data model. Integrations between them are fragile and expensive.
          </p>
          <p>
            We built ReyDesk to replace that stack. One app. One database. One login. Remote sessions, tickets, devices, automation, knowledge base, patch tracking — sharing the same data and the same audit chain.
          </p>
          <p>
            We think the important things are: remote sessions require explicit consent, technicians have the context they need, and the audit trail makes the work explainable after the fact.
          </p>            <p>
            The AI layer is useful but governed. Workers can triage, diagnose, draft, and recommend; permissions and approval rules determine what they may actually do.
          </p>

        </div>
      </section>

      {/* ---- pricing preview ---- */}
      <section className="landing-section">
        <div className="landing-section-head">
          <span className="landing-kicker">Pricing</span>
          <h2 className="landing-h2">No surprises.</h2>
          <p className="landing-section-sub">
            Start free, then scale when your team and device estate grow.
          </p>
        </div>
        <div className="pricing-preview-grid">
          <article className="landing-feature">
            <h3>Free</h3>
            <p>Up to 3 technicians and 100 devices. Remote support, ticketing, and knowledge base with no time limit.</p>
          </article>
          <article className="landing-feature gradient-border">
            <h3 style={{ color: 'var(--accent)' }}>Pro — $79/tech/mo</h3>
            <p>Unlimited technicians and 500 devices. Full RMM, governed AI assistance, patch management, and automations.</p>
          </article>
          <article className="landing-feature">
            <h3>Enterprise</h3>
            <p>Custom pricing for MSPs and larger teams that need multi-tenant controls, SSO, and dedicated support.</p>
          </article>
        </div>
        <div style={{ textAlign: 'center', marginTop: 28 }}>
          <Link className="btn btn-ghost" to="/pricing">Compare plans →</Link>
        </div>
      </section>

      {/* ---- FAQ ---- */}
      <section className="landing-section landing-section-alt" id="faq">
        <div className="landing-section-head">
          <span className="landing-kicker">Before you start</span>
          <h2 className="landing-h2">Straight answers.</h2>
        </div>
        <div className="landing-faq landing-faq-compact">
          <details className="landing-faq-item">
            <summary className="landing-faq-q">Is ReyDesk hosted or self-hosted?</summary>
            <p className="landing-faq-a">ReyDesk is currently delivered as a hosted service. Create a workspace in about a minute and upgrade as your team grows.</p>
          </details>
          <details className="landing-faq-item">
            <summary className="landing-faq-q">How does remote support work?</summary>
            <p className="landing-faq-a">The endpoint user downloads the ReyDesk helper, enters the support code from the technician, reviews the requested permissions, and gives consent before the session starts.</p>
          </details>
          <details className="landing-faq-item">
            <summary className="landing-faq-q">Is there a free plan?</summary>
            <p className="landing-faq-a">Yes. The free workspace supports up to 3 technicians and 100 devices, with remote support, ticketing, and knowledge base access. No credit card is required to start.</p>
          </details>
        </div>
      </section>

      {/* ---- CTA ---- */}
      <section className="landing-cta-band">
        <h2 className="landing-h2">Try it yourself.</h2>
        <p className="landing-sub">
          Create a workspace. It takes about a minute. No sales call.
        </p>
        <div className="landing-cta">
          <Link className="btn btn-primary" to="/signup" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
            Start your free workspace
          </Link>
          <Link className="btn btn-ghost" to="/contact" style={{ height: 44, padding: '0 28px', fontSize: 15 }}>
            Talk to our team
          </Link>
        </div>
      </section>
    </LandingLayout>
  )
}
