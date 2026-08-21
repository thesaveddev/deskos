import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Shell } from '../components/Shell.js'
import LandingLayout from '../components/LandingLayout.js'
import { Icon } from '../components/Icons.js'

interface LessonSection {
  heading: string
  body: string
  steps?: string[]
}

interface Lesson {
  id: string
  category: string
  title: string
  summary: string
  audience: string
  duration: string
  sections: LessonSection[]
  tips: string[]
  links: Array<{ label: string; to: string }>
}

const LESSONS: Lesson[] = [
  {
    id: 'start-here', category: 'Getting started', title: 'Start here: understand the ReyDesk workspace',
    summary: 'A short tour of the parts of ReyDesk and the order in which to set up your service desk.', audience: 'Everyone', duration: '5 min',
    sections: [
      { heading: 'What ReyDesk brings together', body: 'ReyDesk connects ticketing, remote support, endpoint management, monitoring, knowledge, approvals, and reporting in one workspace. A ticket can be linked to a device, a monitoring alert can create a ticket, and a remote session can be recorded in the ticket timeline.' },
      { heading: 'The normal operating rhythm', body: 'Most teams use ReyDesk in this order:', steps: ['Configure your organization, teams, staff roles, and security rules.', 'Set up ticket categories, priorities, SLAs, and escalation rules.', 'Enroll or connect the devices you support.', 'Work the ticket queue, using remote sessions and knowledge articles when needed.', 'Review reports, device health, SLA performance, and audit history.'] },
      { heading: 'The navigation', body: 'Dashboard is your starting point. Tickets is the work queue. Devices and Sessions handle endpoint and remote support work. Knowledge base stores reusable guidance. Settings controls the organization. Learn is this guide, and Support is where you contact the ReyDesk team.' },
    ],
    tips: ['If a menu item is not visible, your role may not have the permission required for it.', 'Use the command palette in the top bar to search tickets and quickly open common actions.', 'The lock button protects your session without signing you out.'],
    links: [{ label: 'Open dashboard', to: '/' }, { label: 'Open settings', to: '/settings' }, { label: 'Open staff management', to: '/staff' }],
  },
  {
    id: 'tickets', category: 'Service desk', title: 'Work tickets from intake to resolution',
    summary: 'Learn how to create, triage, assign, escalate, reply to, and close a ticket without losing context.', audience: 'Agents and managers', duration: '10 min',
    sections: [
      { heading: 'Create a useful ticket', body: 'A good ticket starts with a clear subject and enough context for another agent to continue the work. Include the affected person, department, device or service, business impact, what changed, and what has already been tried. Add files when a screenshot, log, or document will help.' },
      { heading: 'Triage the queue', body: 'Use filters to narrow the queue by status, priority, assignee, team, category, and time. Sort by SLA risk when deciding what to work next. The counts on the queue tabs show the size of each work bucket.', steps: ['Check whether the ticket is new, open, pending, escalated, resolved, or closed.', 'Set the correct priority based on impact and urgency, not just the requester’s wording.', 'Assign the ticket to yourself or the appropriate team.', 'Add an internal note when the information is for agents only; use a public reply for the requester.', 'Link related incidents, problems, changes, assets, or other tickets when the work crosses boundaries.'] },
      { heading: 'Assignment and ticket locks', body: 'Opening a ticket shows who else is viewing it. Claiming or assigning a ticket tells other agents that you are responsible for the next action. Short inactivity locks expire automatically, while managers can unlock a ticket when an agent is unavailable. This prevents duplicate work without blocking collaboration.' },
      { heading: 'Escalate, forward, and resolve', body: 'Escalate when the current team does not have the authority, skill, or access needed. Forward the relevant context rather than asking the requester to start again. Before resolving, state what was done and what the requester should expect. A resolved ticket can be reopened if the issue returns.' },
    ],
    tips: ['Never put passwords, recovery codes, or other secrets in a ticket.', 'Use internal notes for investigation details that should not be shown to the requester.', 'A resolution should be understandable to someone who did not work the ticket.'],
    links: [{ label: 'Open ticket queue', to: '/tickets' }, { label: 'Ticket settings', to: '/settings/tickets' }, { label: 'Open reports', to: '/reports' }],
  },
  {
    id: 'remote-support', category: 'Remote support', title: 'Run a consent-first remote support session',
    summary: 'Connect to a managed or unmanaged device safely, request the right permissions, and leave a complete audit trail.', audience: 'Technicians', duration: '12 min',
    sections: [
      { heading: 'Choose the right connection type', body: 'Managed devices are enrolled into your organization and can support unattended or attended workflows according to policy. Unmanaged support is for a customer or colleague who needs help now: they open the support link or helper, provide the code, and explicitly approve the session.' },
      { heading: 'Request access', body: 'Create or open a session, select only the capabilities you need, and send the support code or secure link. Screen viewing, input control, clipboard, terminal, file transfer, elevation, and system management are separate permissions. The endpoint user must consent before the protected channel becomes active.' },
      { heading: 'During the session', body: 'Start with view-only access and explain what you are doing. Request input control only when necessary. Keep the ticket open so your actions and notes remain connected to the incident. Use the session console to see connection state, consent, channel status, and timeline events.' },
      { heading: 'End the session safely', body: 'Tell the user you are finished, stop the session, and record the outcome. Do not leave a helper or temporary access path running. If an elevation prompt appeared, confirm that the elevated task completed and that no unnecessary administrative process remains.' },
    ],
    tips: ['Consent is required for screen and input channels; a valid code alone is not permission to control a device.', 'Use the smallest permission set that can solve the problem.', 'If a session is negotiating, check that the endpoint agent is online and the relay/WebRTC configuration is reachable.'],
    links: [{ label: 'Open sessions', to: '/sessions' }, { label: 'Open devices', to: '/devices' }, { label: 'Remote support settings', to: '/settings/remote' }],
  },
  {
    id: 'devices', category: 'Remote support', title: 'Enroll and manage devices',
    summary: 'Understand enrollment, device identity, health telemetry, endpoint actions, and the difference between offline and unreachable.', audience: 'Technicians and administrators', duration: '10 min',
    sections: [
      { heading: 'Enrollment is the device identity', body: 'Enrollment creates the trusted relationship between an endpoint agent and your organization. Use the deployment instructions or one-time enrollment code appropriate for the device. Do not enroll the same installation repeatedly; reinstalling or rotating an agent should follow your organization’s replacement procedure.' },
      { heading: 'Read the device record', body: 'A device record combines identity, last contact, IP address when reported, operating system, agent version, assigned group, user, health telemetry, alerts, and related tickets. Online status is based on recent authenticated agent contact; remote-control availability also depends on the session and relay path.' },
      { heading: 'Use health telemetry well', body: 'CPU, memory, disk, battery, uptime, process count, network latency, and storage data help you spot degradation before a user reports a failure. A laptop that is shut down overnight is not necessarily unhealthy. Use maintenance windows, device groups, and alert rules to avoid creating tickets for expected downtime.' },
      { heading: 'Avoid duplicate deployments', body: 'Before deploying, search by hostname, serial number, or existing device identity. If the endpoint already exists, repair or reconnect its agent rather than creating another enrollment.' },
    ],
    tips: ['Offline means the API has not received a recent heartbeat; it does not always mean the screen or network is unusable.', 'Use groups to target policies and reporting consistently.', 'Remove retired devices so old identities do not pollute health and compliance reports.'],
    links: [{ label: 'Open devices', to: '/devices' }, { label: 'Device groups', to: '/devices/groups' }, { label: 'Monitoring', to: '/monitoring' }],
  },
  {
    id: 'monitoring', category: 'Remote support', title: 'Use monitoring without creating alert noise',
    summary: 'Build practical health rules, understand alert states, and avoid tickets for normal laptop and maintenance behavior.', audience: 'Technicians and administrators', duration: '8 min',
    sections: [
      { heading: 'What monitoring is for', body: 'Monitoring turns endpoint telemetry into an early-warning system. It helps you find low disk space, sustained resource pressure, unhealthy services, agent failures, and network problems before they become user-impacting incidents.' },
      { heading: 'Create a useful rule', body: 'Start with one signal, a sensible threshold, a duration, and a recovery condition. Choose whether the rule should create an alert, notify a team, or open a ticket. Apply it to a group rather than every device when the condition is specific to a role or workload.' },
      { heading: 'Handle expected downtime', body: 'Laptops may be shut down outside working hours. Use schedules, maintenance windows, grace periods, and device groups to separate expected absence from an actual outage. A ticket should represent user impact or an actionable risk, not every missed heartbeat.' },
      { heading: 'Investigate an alert', body: 'Open the alert, review recent telemetry and history, check related tickets, and confirm the device’s last contact. Resolve the alert only after the condition has recovered or the expected downtime has been documented.' },
    ],
    tips: ['Start with fewer high-value rules and tune them using real alert history.', 'Use recovery events to close the loop instead of manually closing every alert.', 'Do not use a single offline threshold for desktops, servers, and laptops.'],
    links: [{ label: 'Open monitoring', to: '/monitoring' }, { label: 'Monitoring settings', to: '/settings/monitoring' }, { label: 'Open reports', to: '/reports' }],
  },
  {
    id: 'knowledge', category: 'Knowledge and automation', title: 'Build a knowledge base people will actually use',
    summary: 'Write clear articles, keep them reviewed, and connect guidance to tickets and support work.', audience: 'Agents, editors, and managers', duration: '8 min',
    sections: [
      { heading: 'Choose the right article type', body: 'Use how-to articles for repeatable tasks, troubleshooting guides for symptoms and decision paths, FAQs for short answers, and incident resolutions for what happened and how it was fixed. One article should answer one practical question.' },
      { heading: 'Write for the person doing the work', body: 'Start with the outcome, list prerequisites, then give numbered steps. Use plain language and name the exact screen, button, or command. Explain what success looks like and what to do if the step fails.' },
      { heading: 'Control publication', body: 'Drafts are for working content. Review status means someone should validate it. Published content is available according to its visibility. Set a review date so old instructions return to the review queue instead of silently becoming unreliable.' },
      { heading: 'Use relationships and feedback', body: 'Link prerequisites, related guidance, and follow-up articles. Review helpfulness feedback and search misses. If people repeatedly ask the same question in tickets, that is a strong candidate for a new or improved article.' },
    ],
    tips: ['Put version-specific details in the article so readers know whether it applies to them.', 'Never publish secrets or customer-specific credentials.', 'A short article with a clear decision path is better than a long page that nobody scans.'],
    links: [{ label: 'Open knowledge base', to: '/kb' }, { label: 'Open tickets', to: '/tickets' }, { label: 'Open automation rules', to: '/automations' }],
  },
  {
    id: 'team', category: 'Organizations and teams', title: 'Set up teams, roles, and organization access',
    summary: 'Invite staff safely, give people the access they need, and keep customer organizations separated.', audience: 'Organization administrators', duration: '10 min',
    sections: [
      { heading: 'Understand multi-tenancy', body: 'Each organization has its own users, tickets, devices, sessions, settings, and audit history. A user may belong to more than one organization, but the active organization determines what they are viewing and changing.' },
      { heading: 'Invite a staff member', body: 'Open Staff management, invite the person’s work email, assign an organization role, and add them to the teams they will work with. Give managers the ability to assign and escalate; give agents only the operational access they require.' },
      { heading: 'Use teams as a work boundary', body: 'Teams make assignment, escalation, reporting, and notifications more useful. Create teams that match how work is actually handled—service desk, field support, infrastructure, security, or a specialist queue.' },
      { heading: 'Review access regularly', body: 'Remove former staff, review dormant accounts, and check memberships when responsibilities change. Keep platform administration separate from day-to-day ticket work.' },
    ],
    tips: ['Invite users with work addresses and make the purpose of their access clear.', 'Use permissions and teams together; a role alone does not describe every operational boundary.', 'Test access with a low-privilege account before rolling out a new policy.'],
    links: [{ label: 'Staff management', to: '/staff' }, { label: 'Organization settings', to: '/settings' }, { label: 'Security settings', to: '/settings/security' }],
  },
  {
    id: 'security', category: 'Security', title: 'Protect accounts with MFA, sessions, and approvals',
    summary: 'Configure strong sign-in protection and understand how ReyDesk guards privileged actions.', audience: 'Everyone', duration: '9 min',
    sections: [
      { heading: 'Set up MFA', body: 'Open Security settings, start authenticator setup, scan the QR code with a TOTP-compatible app, and confirm the current code. Save the recovery codes somewhere secure before finishing. Recovery codes are for account recovery, not everyday sign-in.' },
      { heading: 'Organization MFA policy', body: 'An organization can make MFA required or allow users to opt in. When MFA is required and a user has not enrolled, the sign-in flow should guide them through setup rather than leaving them locked out.' },
      { heading: 'Lock versus sign out', body: 'Locking protects the current workstation and lets the same user unlock with their password and MFA when required. Signing out revokes the session and sends the user to the lock-style sign-in screen with their identity preserved.' },
      { heading: 'Privileged access', body: 'Elevation, terminal, file transfer, system management, and remote input are sensitive capabilities. Use approvals and consent, keep the scope narrow, and review the audit trail after the action.' },
    ],
    tips: ['Store recovery codes in a password manager or approved secure vault.', 'Do not approve an elevation request you cannot explain.', 'Use passkeys where your organization supports them, especially for administrators.'],
    links: [{ label: 'Security settings', to: '/settings/security' }, { label: 'Access approvals', to: '/approvals' }, { label: 'Audit and compliance', to: '/compliance' }],
  },
  {
    id: 'reports', category: 'Reporting', title: 'Read reports and turn data into action',
    summary: 'Use operational reports to understand workload, service quality, devices, and team performance.', audience: 'Managers and administrators', duration: '7 min',
    sections: [
      { heading: 'Start with a question', body: 'Choose the decision you need to make before opening a chart. Examples: Which queues are breaching SLA? Which devices generate repeat incidents? Is the team resolving work faster? Which services create the most demand?' },
      { heading: 'Filter the period and scope', body: 'Use time range, team, priority, status, category, organization, and assignee filters to avoid mixing unrelated work. Compare like with like—for example, business hours and after-hours tickets should not be treated as the same workload.' },
      { heading: 'Read the main measures', body: 'Volume shows demand. First response and resolution time show service speed. SLA compliance shows whether commitments were met. Reopen rate and repeat incidents show whether fixes lasted. Device health and DEX trends show where endpoint experience is deteriorating.' },
      { heading: 'Export responsibly', body: 'Export only the scope you need and treat downloaded reports as sensitive operational data. Remove personal information before sharing outside the organization.' },
    ],
    tips: ['A rising ticket count is not automatically poor performance; it may indicate successful adoption or a major event.', 'Pair a speed metric with a quality metric.', 'Use trends and distributions, not one isolated number.'],
    links: [{ label: 'Open reports', to: '/reports' }, { label: 'Open compliance', to: '/compliance' }, { label: 'Open dashboard', to: '/' }],
  },
  {
    id: 'mobile', category: 'Mobile app', title: 'Use ReyDesk on a phone or tablet',
    summary: 'Find the most important mobile actions and understand what still depends on native device setup.', audience: 'Everyone', duration: '5 min',
    sections: [
      { heading: 'The mobile layout', body: 'The mobile shell puts Dashboard, Tickets, Devices, Sessions, and Settings in the bottom navigation. Less frequent pages are under More. Use the back button in the top bar when you are inside a nested page.' },
      { heading: 'Good mobile tasks', body: 'Mobile is ideal for checking queues, replying to tickets, approving access requests, reviewing device health, starting a support session, and receiving notifications while away from a desk.' },
      { heading: 'Notifications', body: 'Open Settings → Notifications and grant permission deliberately. Browser push and native mobile push are separate delivery paths; native store builds also require platform credentials and signing configuration.' },
      { heading: 'Remote control on mobile', body: 'Use mobile for monitoring and session oversight. Touch control and media performance depend on the endpoint, relay, network, and the native build. Test sensitive remote actions on the devices your technicians actually use.' },
    ],
    tips: ['Keep the app updated so the web shell and endpoint APIs remain compatible.', 'Use the lock action when handing a phone or tablet to someone else.', 'Do not rely on notifications alone for critical incidents.'],
    links: [{ label: 'Notification settings', to: '/settings/notifications' }, { label: 'Open sessions', to: '/sessions' }, { label: 'Open tickets', to: '/tickets' }],
  },
  {
    id: 'assets', category: 'Inventory and assets', title: 'Manage assets, assignments, and the CMDB',
    summary: 'Keep physical inventory, endpoint identity, staff ownership, and ticket context connected throughout the asset lifecycle.', audience: 'Technicians, asset managers, and administrators', duration: '11 min',
    sections: [
      { heading: 'Keep the identifiers separate', body: 'An asset tag is the human-friendly inventory label. The hostname identifies the endpoint on a network, the serial number identifies the manufacturer record, and the ReyDesk device ID identifies the platform record. Keep all four when available; changing a hostname should not create a new asset.' },
      { heading: 'Assign a device properly', body: 'Assign a primary user, department or team, status, reason, and expected return date. Shared devices should be assigned to a pool rather than silently attributed to the last person who logged in. Temporary replacements should be marked as temporary so they are visible during offboarding.' },
      { heading: 'Use assignment history', body: 'ReyDesk closes the previous assignment when a device is transferred or returned. The history records who had it, who performed the change, when it happened, the reason, department, notes, and audit event. This is the record to use when investigating an incident from the past.' },
      { heading: 'Tag and find physical equipment', body: 'Use an immutable tag such as ITL-LAP-000421 and print a QR or barcode label. Scanning the label should take a technician to the device, current assignment, open tickets, warranty details, health, and previous assignments. Do not reuse a tag after retirement.' },
      { heading: 'Offboard safely', body: 'Before disabling a staff member, review their active devices, returned equipment, software licences, open tickets, and last known check-in. Record the return condition and transfer each asset to its next owner or shared pool.' },
    ],
    tips: ['Do not use the last interactive Windows user as the permanent asset owner.', 'Search by asset tag before creating a new physical record.', 'An unassigned device is a work queue, not necessarily an error—review it by group and lifecycle status.'],
    links: [{ label: 'Open assets', to: '/assets' }, { label: 'Open devices', to: '/devices' }, { label: 'Open staff management', to: '/staff' }],
  },
  {
    id: 'dex', category: 'Experience management', title: 'Understand DEX and improve user experience',
    summary: 'Use digital employee experience signals to find persistent friction, explain score changes, and target remediation.', audience: 'Managers, service owners, and endpoint teams', duration: '9 min',
    sections: [
      { heading: 'DEX is more than device health', body: 'Digital employee experience combines what the endpoint reports with what the person experiences. A device can be technically online while a user still struggles with slow logins, unreliable Wi-Fi, crashing applications, or a business app that takes too long to launch.' },
      { heading: 'Read the four component scores', body: 'Performance experience covers resource pressure and application responsiveness. Availability experience covers uptime, heartbeat, and reachability. Security posture covers security facts and compliance signals. User-impact signals include surveys, support tickets, affected users, and application experience.' },
      { heading: 'Compare the right populations', body: 'Use device type, department, team, location, and application to compare similar groups. A server should not be scored with laptop weights, and a design workstation should not be compared directly with a kiosk. Segmenting the fleet makes the result actionable.' },
      { heading: 'Explain and act on a change', body: 'When a score drops, inspect the contributing facts and historical baseline rather than reacting to the headline number. Identify the affected people and devices, check for a common change or location, then apply a remediation or create a ticket only when the deterioration is persistent.' },
      { heading: 'Use DEX as a feedback loop', body: 'Track whether remediation improved the experience. Combine trends with user feedback and ticket outcomes. A good DEX program turns repeated complaints into a measurable improvement plan instead of a collection of disconnected fixes.' },
    ],
    tips: ['A score is a signal for investigation, not a judgement of a person or team.', 'Use historical percentiles and trends to avoid overreacting to one bad sample.', 'Prioritize problems affecting many users or critical business applications.'],
    links: [{ label: 'Open DEX', to: '/reports' }, { label: 'Open monitoring', to: '/monitoring' }, { label: 'Open tickets', to: '/tickets' }],
  },
  {
    id: 'calls', category: 'Communication', title: 'Use calls and ticket activity together',
    summary: 'Connect telephony to ReyDesk so outbound calls, inbound webhooks, matching, and call outcomes remain part of the service record.', audience: 'Agents and service-desk managers', duration: '7 min',
    sections: [
      { heading: 'Why call activity belongs in the ticket', body: 'A phone conversation often changes the next action faster than a written reply. Recording the call direction, number, provider status, duration, agent, and linked ticket prevents important decisions from disappearing into a personal call log.' },
      { heading: 'Make an outbound call', body: 'Open a ticket or the Calls workspace, confirm the requester and number, then use click-to-call. ReyDesk creates the activity and updates its status as the provider reports initiated, ringing, answered, completed, missed, or failed.' },
      { heading: 'Handle inbound calls', body: 'Configure the provider webhook with the public callback URL and signature validation. When a call arrives, ReyDesk can match the caller to a user or organization, suggest related open tickets, and let the agent attach the call to the correct record.' },
      { heading: 'Protect telephony data', body: 'Keep provider credentials in the encrypted integration record, never in the browser or ticket body. Validate webhook signatures, restrict callback routes, and limit who can view phone numbers and call metadata.' },
    ],
    tips: ['Confirm the number before calling and respect your organization’s recording policy.', 'Write a short outcome note when a call changes the plan.', 'If automatic matching is uncertain, link the call manually rather than attaching it to the wrong ticket.'],
    links: [{ label: 'Open Calls', to: '/calls' }, { label: 'Open tickets', to: '/tickets' }, { label: 'Integrations', to: '/integrations' }],
  },
  {
    id: 'notifications', category: 'Communication', title: 'Configure notifications that people can trust',
    summary: 'Choose useful email and push events, understand delivery paths, and avoid alert fatigue.', audience: 'Everyone', duration: '6 min',
    sections: [
      { heading: 'Choose the channel for the urgency', body: 'In-app notifications are best for work already happening in ReyDesk. Email is useful for durable updates and people who are not watching the queue. Push is useful for time-sensitive attention on a phone or desktop, but should not be the only path for critical operational events.' },
      { heading: 'Keep preferences user-controlled', body: 'Users should be able to choose which events they receive where the organization policy permits. Managers can set defaults for team events, while security and access notifications should remain difficult to suppress.' },
      { heading: 'Understand email delivery', body: 'ReyDesk places outbound messages on a queue, retries transient failures, and uses branded HTML with a plain-text alternative. Production deployments need a real SMTP provider, verified sender identity, DNS authentication, and monitoring for bounces and complaints.' },
      { heading: 'Test push deliberately', body: 'Grant browser or native permission from Notification settings, register the device, and send a test. A successful browser subscription does not prove that a native mobile build has its platform credentials or that every device will receive a notification.' },
    ],
    tips: ['Do not send every low-priority telemetry event as push.', 'When debugging delivery, record the event ID and inspect queue and provider logs.', 'Treat email addresses, device subscriptions, and notification content as personal data.'],
    links: [{ label: 'Notification settings', to: '/settings/notifications' }, { label: 'Email settings', to: '/settings/email' }, { label: 'Open dashboard', to: '/' }],
  },
  {
    id: 'administration', category: 'Administration', title: 'Run the organization day to day',
    summary: 'A practical operating guide for settings, billing, audit, support, and platform administration.', audience: 'Organization owners and administrators', duration: '12 min',
    sections: [
      { heading: 'Set up before inviting everyone', body: 'Choose the organization name and branding, define roles and teams, configure ticket defaults and SLAs, decide the MFA policy, and establish who can approve elevation or manage integrations. Defaults reduce inconsistent work later.' },
      { heading: 'Separate operational and platform duties', body: 'Service-desk managers should manage queues and people. Security administrators should manage MFA, passkeys, sessions, and privileged access. Billing owners should manage subscription and invoices. Keep platform-wide administration limited to trusted operators.' },
      { heading: 'Use the audit trail', body: 'Audit history answers who changed a setting, assigned a device, approved access, created a session, or modified a ticket. Review it during offboarding, incident investigations, and periodic access reviews.' },
      { heading: 'Keep billing and usage understandable', body: 'Review the active plan, seats, devices, storage, and usage before renewal. Make sure the organization knows which features depend on hosted infrastructure, email, TURN, object storage, or provider integrations.' },
      { heading: 'Operate support as a product', body: 'Customers need a public support path, clear response expectations, and a place to follow their own requests. Use internal admin support to track recurring complaints and convert them into product or documentation improvements.' },
    ],
    tips: ['Document your organization’s approval and escalation policy in the knowledge base.', 'Review inactive accounts and unused integrations monthly.', 'Do not use a shared administrator login.'],
    links: [{ label: 'Staff management', to: '/staff' }, { label: 'Settings', to: '/settings' }, { label: 'Billing', to: '/billing' }],
  },
  {
    id: 'integrations', category: 'Integrations', title: 'Connect ReyDesk to the rest of your stack',
    summary: 'Use webhooks, the API, marketplace apps, and directory integration without weakening tenant or secret boundaries.', audience: 'Administrators and developers', duration: '10 min',
    sections: [
      { heading: 'Start with an integration purpose', body: 'Write down what system of record should own each object. For example, a directory may own staff identity, ReyDesk may own tickets, and a monitoring platform may publish alerts. Clear ownership prevents sync loops and conflicting edits.' },
      { heading: 'Use webhooks for events', body: 'Webhooks are useful for ticket creation, status changes, sessions, and device events. Use an HTTPS endpoint, verify signatures, make your receiver idempotent, and return quickly before processing heavier work from a queue.' },
      { heading: 'Use the API for controlled reads and writes', body: 'Create a dedicated client with the smallest scopes possible. Store the secret in a vault, rotate it, log request IDs rather than tokens, and apply tenant-aware filtering to every integration workflow.' },
      { heading: 'Directory and SSO', body: 'Active Directory or Entra integration can reduce duplicate user administration, but it does not remove the need to review roles, teams, MFA policy, and offboarding. Test mapping with a small group before a full synchronization.' },
      { heading: 'Operate integrations', body: 'Monitor delivery failures, retries, revoked credentials, rate limits, and schema changes. Provide a replay or recovery path for important events instead of assuming every network call succeeds once.' },
    ],
    tips: ['Never paste API secrets into tickets or knowledge articles.', 'Use a separate integration identity for each external system.', 'Test failure and retry behavior before enabling an integration for all organizations.'],
    links: [{ label: 'Integration settings', to: '/settings/integrations' }, { label: 'Developer API', to: '/api-docs' }, { label: 'Marketplace', to: '/marketplace' }],
  },
  {
    id: 'production', category: 'Deployment and operations', title: 'Prepare ReyDesk for production',
    summary: 'A release checklist for hosting, secrets, networking, storage, backups, observability, and capacity.', audience: 'Platform owners and deployment teams', duration: '14 min',
    sections: [
      { heading: 'Choose the initial shape', body: 'For an early production deployment, a horizontally-scalable application can still run as a small number of practical services: web/API, relay, database, and supporting storage. Separate components when load, reliability, security, or operational ownership justifies it—not because a diagram looks more impressive.' },
      { heading: 'Protect the deployment', body: 'Use HTTPS everywhere, a stable JWT and encryption key from a secret manager, restricted CORS origins, database backups, private database networking, rate limits, and signed endpoint releases. Never use development secrets or ephemeral keys in production.' },
      { heading: 'Plan the media and file paths', body: 'Remote sessions need a reliable relay and TURN deployment for difficult networks. Large attachments and recordings should use durable object storage rather than local disk. Test NAT traversal, reconnect, session termination, and storage cleanup.' },
      { heading: 'Measure before scaling', body: 'Track API latency, WebSocket connections, relay joins, active sessions, database pool pressure, queue depth, email failures, recording storage, and endpoint heartbeat volume. Run repeatable browser and k6 tests for the expected connection and session mix.' },
      { heading: 'Practice failure recovery', body: 'Restore a database backup, rotate a secret, restart a relay node, replay a webhook, recover a queued email, roll back an agent update, and verify that a terminated remote session cannot reconnect without authorization.' },
    ],
    tips: ['A production checklist is incomplete until someone has exercised it.', 'Keep deployment configuration separate from user data and source code.', 'Scale the bottleneck you measured, not the service that is easiest to duplicate.'],
    links: [{ label: 'Production guide', to: '/support' }, { label: 'API documentation', to: '/api-docs' }, { label: 'Compliance', to: '/compliance' }],
  },
  {
    id: 'troubleshooting', category: 'Troubleshooting', title: 'When something does not work',
    summary: 'A practical checklist for diagnosing sign-in, ticket, device, remote session, and notification problems.', audience: 'Everyone', duration: '6 min',
    sections: [
      { heading: 'Start with the scope', body: 'Check whether the problem affects one user, one organization, one device, or everyone. Note the exact time, page, action, and message. A screenshot and browser console error are more useful than “it does not work”.' },
      { heading: 'Sign-in and MFA', body: 'Confirm the email, password, organization, time on the authenticator device, and whether the account is locked. If the organization requires MFA, follow the setup flow or use a saved recovery code. Password reset requires the configured outbound SMTP service.' },
      { heading: 'Tickets and pages', body: 'Hard-refresh after a deployment, check that your session has not expired, and try the page again without a stale tab. If only one ticket fails, record its number. If many pages are blank, capture the first browser error and check the API health/logs.' },
      { heading: 'Devices and remote sessions', body: 'Check last heartbeat, agent version, consent, requested permissions, relay availability, and whether a firewall or sleep state is involved. “Offline” and “remote channel unavailable” are separate conditions.' },
      { heading: 'Escalate to support', body: 'Use Support to raise a ticket with the affected organization, user, page, steps to reproduce, expected result, actual result, and any correlation or session identifier shown by ReyDesk.' },
    ],
    tips: ['Never paste access tokens, passwords, MFA codes, or private keys into a support ticket.', 'Try one controlled change at a time so the cause remains clear.', 'Keep the original error text; paraphrasing can hide the useful part.'],
    links: [{ label: 'Open support', to: '/support' }, { label: 'Open settings', to: '/settings' }, { label: 'Open sessions', to: '/sessions' }],
  },
  {
    id: 'customer-portal', category: 'Customer experience', title: 'Use the customer portal from request to closure',
    summary: 'Give requesters a clear, secure way to raise tickets, follow replies, add context, and confirm resolution.', audience: 'End users and customer administrators', duration: '8 min',
    sections: [
      { heading: 'What the portal is for', body: 'The portal is the requester-facing side of ReyDesk. A customer can create a request, see its status, read public replies, respond when more information is needed, and mark the issue resolved. Internal notes, private team discussions, and privileged actions stay out of the portal.' },
      { heading: 'Raise a useful request', body: 'Describe the symptom, when it started, who is affected, the business impact, and what has already been tried. Include the device or service when known. Do not include passwords, MFA codes, API keys, or confidential data that the support team does not need.' },
      { heading: 'Understand the status', body: 'New means the request has entered the queue. Open means work is active. Pending user means the service desk needs an answer. Escalated means another team or specialist is involved. Resolved means a fix or answer was provided; reply if the problem returns.' },
      { heading: 'Use email and portal together', body: 'Replies from supported email channels can be matched to the ticket when the ticket reference is present. If a reply is not matched, open the portal and add it there so the conversation remains attached to the right request.' },
    ],
    tips: ['Only share information that is necessary to solve the issue.', 'Check the ticket number before replying to an email thread.', 'Mark a ticket resolved only when the outcome is clear to the requester.'],
    links: [{ label: 'Open customer portal', to: '/portal' }, { label: 'Create a ticket', to: '/portal/new' }, { label: 'Support', to: '/support' }],
  },
  {
    id: 'collaboration', category: 'Collaboration', title: 'Use notes, chat, and attachments without losing context',
    summary: 'Keep personal working notes, team conversations, ticket replies, and files in the right place.', audience: 'Everyone', duration: '7 min',
    sections: [
      { heading: 'Choose the right workspace', body: 'Notes are personal working space for reminders and reusable thoughts. Team chat is for quick coordination with the people assigned to a team. Ticket replies are the durable customer conversation. Internal notes are the durable agent-only record attached to a ticket.' },
      { heading: 'Organize notes', body: 'Use categories, colors, and pinned notes to keep recurring procedures or current priorities easy to find. Notes save automatically. Do not treat a personal note as the official record of a customer decision—copy the relevant outcome into the ticket.' },
      { heading: 'Share files safely', body: 'Attach screenshots, logs, and documents to the ticket or approved knowledge article rather than sending them through an untracked chat. Check the filename and audience before uploading. Remove unnecessary personal data from screenshots and logs.' },
      { heading: 'Write collaboration that another person can use', body: 'State what you know, what is uncertain, and what should happen next. Mention the ticket, device, or session explicitly. When a chat decision changes the work, record the decision in the ticket timeline.' },
    ],
    tips: ['A chat message is easy to miss; a ticket timeline entry is easier to audit.', 'Never store secrets in notes, chat, attachments, or knowledge articles.', 'Pin only the notes you actively need at the top.'],
    links: [{ label: 'Open notes', to: '/notes' }, { label: 'Open team chat', to: '/chat' }, { label: 'Open tickets', to: '/tickets' }],
  },
  {
    id: 'ai-triage', category: 'AI and automation', title: 'Understand AI ticket triage and human handoff',
    summary: 'Use bounded AI to ask safe diagnostic questions, summarize evidence, and stop at the right moment.', audience: 'Agents, managers, and administrators', duration: '9 min',
    sections: [
      { heading: 'What the AI assistant can do', body: 'When enabled by the organization, AI triage reads an eligible ticket, asks one focused diagnostic question at a time, records the exchange, summarizes evidence, and suggests next steps. It can help with common issues such as peripherals, access, connectivity, and basic endpoint symptoms.' },
      { heading: 'What it must not do', body: 'The assistant does not request passwords or MFA codes, run arbitrary terminal commands, bypass consent, change security controls, or silently take control of a device. It should not make a high-impact decision when the evidence is incomplete or the issue involves security, privacy, safety, or privileged access.' },
      { heading: 'Configure the boundary', body: 'Administrators control whether triage is enabled, whether public replies are allowed, how many question rounds are permitted, the confidence needed for auto-resolution, and which ticket sources are eligible. Start conservatively and review the transcript before widening the scope.' },
      { heading: 'Take over as a human', body: 'Stop or retry triage from the ticket when the requester is confused, the answer is ambiguous, the issue is urgent, or the proposed fix did not work. Review the AI question, answer, confidence, evidence, and handoff reason before replying.' },
    ],
    tips: ['AI confidence is not proof; verify the outcome with the requester.', 'Keep AI replies clear that a human can take over.', 'Do not enable auto-resolution for security, major incident, or privileged-access categories.'],
    links: [{ label: 'AI settings', to: '/settings/ai' }, { label: 'Open ticket queue', to: '/tickets' }, { label: 'Automations', to: '/automations' }],
  },
  {
    id: 'catalogue-approvals', category: 'Service management', title: 'Manage service requests, changes, and approvals',
    summary: 'Use the service catalogue and approval workflow to make repeatable requests controlled and visible.', audience: 'Agents, requesters, and approvers', duration: '10 min',
    sections: [
      { heading: 'Incident versus service request', body: 'An incident restores something that is broken. A service request asks for a standard, approved outcome such as access, software, equipment, or a routine change. Correct classification improves routing, reporting, and expectations.' },
      { heading: 'Use the service catalogue', body: 'A catalogue item should describe what the requester gets, who can request it, the information required, the expected fulfilment time, and whether approval is needed. Keep the form smaller than the underlying process; ask only for information that changes the decision or work.' },
      { heading: 'Approve with context', body: 'Approvers should see the requester, business reason, risk, cost, affected service, and requested date. Approve, reject, or return for information deliberately. An approval is an accountable decision, not a substitute for technical validation.' },
      { heading: 'Handle change and major incidents', body: 'Changes need an implementation plan, backout plan, risk, schedule, and approval trail. Major incidents need clear ownership, stakeholder communication, timeline updates, and a post-incident review. Link related tickets and the final resolution so the record remains complete.' },
    ],
    tips: ['Do not use a service request to hide an unplanned outage.', 'A rejected request should explain what alternative the requester can use.', 'Close the approval loop in the ticket timeline.'],
    links: [{ label: 'Service catalogue', to: '/services' }, { label: 'Approvals', to: '/approvals' }, { label: 'Major incidents', to: '/incidents' }],
  },
  {
    id: 'endpoint-operations', category: 'Endpoint operations', title: 'Operate scripts, patches, and endpoint actions safely',
    summary: 'Use RMM capabilities to improve fleet reliability while keeping execution approved, scoped, and auditable.', audience: 'Endpoint engineers and administrators', duration: '11 min',
    sections: [
      { heading: 'Separate observation from action', body: 'Telemetry and inventory are observations. Scripts, patches, service changes, and remote commands are actions. Review the evidence first, then choose the smallest approved action that addresses the problem.' },
      { heading: 'Use approved scripts', body: 'Store scripts with an owner, purpose, version, supported operating systems, timeout, output handling, and rollback or recovery instructions. Test in a lab or pilot group before using a script across production endpoints.' },
      { heading: 'Plan patch work', body: 'Use maintenance windows, device groups, reboot expectations, exclusion rules, and a recovery path. Track the patch result per device and follow up on machines that are offline, failed, or waiting for a restart.' },
      { heading: 'Protect execution', body: 'Require the right permission or approval for privileged actions, record who approved and who ran them, and prevent arbitrary user-supplied commands from entering an automated workflow. A failed action must not stop telemetry from reporting.' },
    ],
    tips: ['Start with read-only diagnostics when investigating an unfamiliar issue.', 'Never embed credentials in a script.', 'A command that works on one Windows build may be unsafe on another—declare compatibility.'],
    links: [{ label: 'RMM workspace', to: '/rmm' }, { label: 'Scripts', to: '/scripts' }, { label: 'Patch management', to: '/patches' }],
  },
  {
    id: 'billing', category: 'Administration', title: 'Manage plans, seats, and subscription billing',
    summary: 'Understand the commercial controls behind an organization and keep usage aligned with the selected plan.', audience: 'Organization owners and billing administrators', duration: '6 min',
    sections: [
      { heading: 'Know what the plan controls', body: 'Plans may affect staff seats, managed devices, remote sessions, storage, recordings, automation, AI usage, and support commitments. Confirm the current limits before enabling a workflow that depends on a paid capability.' },
      { heading: 'Keep billing ownership clear', body: 'Billing contacts and organization administrators may be different people. Keep payment details and invoices restricted to the appropriate role, and remove former billing contacts during offboarding.' },
      { heading: 'Watch usage before renewal', body: 'Review active members, enrolled devices, session volume, attachment and recording storage, and integration usage. Retire unused identities and define retention rules before increasing a plan solely because old data is accumulating.' },
      { heading: 'Plan for service continuity', body: 'Know what happens if payment fails, a trial ends, or a plan changes. Export the records your organization is entitled to retain, maintain a support contact, and test that essential ticket and device workflows remain understandable during a billing transition.' },
    ],
    tips: ['Never place card details in a ticket or chat message.', 'Assign at least two trusted billing administrators for continuity.', 'Billing changes should be recorded and communicated before they affect support operations.'],
    links: [{ label: 'Open billing', to: '/billing' }, { label: 'Staff management', to: '/staff' }, { label: 'Contact support', to: '/support' }],
  },
  {
    id: 'governance', category: 'Security and compliance', title: 'Apply privacy, retention, and audit discipline',
    summary: 'Make ReyDesk safer to operate by controlling personal data, privileged evidence, retention, and review routines.', audience: 'Security, compliance, and organization administrators', duration: '10 min',
    sections: [
      { heading: 'Collect only what the workflow needs', body: 'Requester details, device telemetry, call metadata, session recordings, attachments, and audit events can contain personal or sensitive information. Define why each data type is collected, who needs access, and how long it should remain available.' },
      { heading: 'Separate visibility levels', body: 'Public replies are for requesters. Internal notes and team chat are for authorized staff. Session recordings, terminal output, elevation evidence, and security events require stricter access than ordinary ticket text.' },
      { heading: 'Use the audit trail as evidence', body: 'Review authentication, membership, MFA resets, privileged approvals, device assignment, ticket changes, remote sessions, and integrations. Investigate unexpected actions and retain the relevant evidence according to policy.' },
      { heading: 'Practice access reviews', body: 'On a regular schedule, review organization memberships, team membership, service accounts, API clients, webhook endpoints, device assignments, and passkeys. Offboarding should revoke access, return assets, and rotate credentials where needed.' },
      { heading: 'Respond to incidents', body: 'Preserve timestamps and identifiers, contain the affected account or integration, avoid editing evidence unnecessarily, notify the responsible owner, and document the recovery. Use ReyDesk tickets and approvals to coordinate the response.' },
    ],
    tips: ['Do not use production customer data for casual testing.', 'Make retention and deletion behavior understandable to administrators.', 'A secure default is better than a policy nobody can operate consistently.'],
    links: [{ label: 'Security settings', to: '/settings/security' }, { label: 'Compliance', to: '/compliance' }, { label: 'Approvals', to: '/approvals' }],
  },
  {
    id: 'developer-platform', category: 'Developer platform', title: 'Build safely with the ReyDesk API and marketplace',
    summary: 'Extend ReyDesk with API clients and marketplace applications while preserving permissions, tenant boundaries, and supportability.', audience: 'Developers and platform administrators', duration: '10 min',
    sections: [
      { heading: 'Choose the integration surface', body: 'Use the public API for deliberate reads and writes, webhooks for event delivery, and marketplace applications for packaged capabilities. Avoid browser automation when a supported API or event exists.' },
      { heading: 'Design for tenants and permissions', body: 'Every request should have an explicit organization context and the smallest required scope. Never assume that an identifier from one organization is valid in another. Check role and permission behavior with both an administrator and a restricted account.' },
      { heading: 'Make clients reliable', body: 'Use request IDs, timeouts, bounded retries with backoff, idempotency keys where supported, and safe handling for 401, 403, 404, 409, 429, and 5xx responses. Do not retry a destructive action blindly.' },
      { heading: 'Publish an application responsibly', body: 'Document permissions, data access, webhooks, support ownership, upgrade behavior, and uninstall cleanup. Keep credentials in a secret manager and give administrators a way to revoke access without deleting their organization.' },
    ],
    tips: ['Treat API keys as passwords and rotate them after any exposure.', 'Never log authorization headers or webhook secrets.', 'Test uninstall, token revocation, replay protection, and tenant isolation before release.'],
    links: [{ label: 'API documentation', to: '/api-docs' }, { label: 'Developer workspace', to: '/developer' }, { label: 'Marketplace', to: '/marketplace' }],
  },
]

const CATEGORIES = [...new Set(LESSONS.map((lesson) => lesson.category))]

export default function LearnPage({ publicView = false }: { publicView?: boolean }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selectedId, setSelectedId] = useState(LESSONS[0].id)

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return LESSONS.filter((lesson) => {
      if (category && lesson.category !== category) return false
      if (!term) return true
      return `${lesson.title} ${lesson.summary} ${lesson.category} ${lesson.audience} ${lesson.sections.map((section) => `${section.heading} ${section.body}`).join(' ')}`.toLowerCase().includes(term)
    })
  }, [category, query])

  const selected = LESSONS.find((lesson) => lesson.id === selectedId) ?? filtered[0] ?? LESSONS[0]

  const content = (
      <div className="learn-page">
        <header className="learn-hero">
          <div>
            <span className="etch">ReyDesk Learn</span>
            <h1 className="page-title">A clear guide to getting work done.</h1>
            <p className="learn-hero-copy">Understand the workspace, follow the right process, and know where to look when something needs attention.</p>
          </div>
          <div className="learn-hero-mark" aria-hidden="true"><Icon name="folder" size={28} /></div>
        </header>

        <div className="learn-toolbar">
          <div className="learn-search"><Icon name="search" size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search the guide…" aria-label="Search the Learn guide" /></div>
          <select className="field-input learn-category-select" value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filter lessons by topic">
            <option value="">Every topic</option>
            {CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <span className="learn-result-count">{filtered.length} {filtered.length === 1 ? 'lesson' : 'lessons'}</span>
        </div>

        <div className="learn-layout">
          <aside className="learn-topic-panel" aria-label="Learn topics">
            <div className="learn-topic-heading"><span className="etch">Topics</span><span>{LESSONS.length}</span></div>
            <nav className="learn-topic-list">
              {filtered.map((lesson) => <button type="button" key={lesson.id} className={`learn-topic${selected.id === lesson.id ? ' active' : ''}`} onClick={() => setSelectedId(lesson.id)}><span className="learn-topic-category">{lesson.category}</span><strong>{lesson.title}</strong><small>{lesson.duration} · {lesson.audience}</small></button>)}
              {filtered.length === 0 ? <p className="learn-no-results">No lessons match that search. Try a broader term.</p> : null}
            </nav>
          </aside>

          <article className="learn-lesson">
            <div className="learn-lesson-head"><div><span className="learn-lesson-category">{selected.category}</span><h2>{selected.title}</h2><p>{selected.summary}</p></div><div className="learn-lesson-meta"><span><Icon name="clock" size={14} />{selected.duration}</span><span><Icon name="user" size={14} />{selected.audience}</span></div></div>
            <div className="learn-sections">
              {selected.sections.map((section, index) => <section className="learn-section" key={section.heading}><div className="learn-section-number">{String(index + 1).padStart(2, '0')}</div><div><h3>{section.heading}</h3><p>{section.body}</p>{section.steps ? <ol>{section.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}</div></section>)}
            </div>
            <aside className="learn-tips"><div className="learn-tips-head"><Icon name="shield" size={16} /><strong>Useful to remember</strong></div><ul>{selected.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul></aside>
            <div className="learn-next"><div><span className="etch">Continue in ReyDesk</span><p>Open the relevant workspace and put this lesson into practice.</p></div><div className="learn-next-links">{selected.links.map((link) => <Link className="btn btn-ghost btn-sm" key={link.to} to={link.to}>{link.label}<Icon name="chevron-right" size={14} /></Link>)}</div></div>
          </article>
        </div>
      </div>
  )

  return publicView
    ? <LandingLayout title="ReyDesk Learn — IT support guides" description="Practical guides for using ReyDesk tickets, remote support, devices, and administration.">{content}</LandingLayout>
    : <Shell>{content}</Shell>
}
