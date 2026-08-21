# 02 — Product Requirements Document (PRD)

## 1. Vision

ReyDesk is the working environment of an IT support professional: helpdesk, ITSM, remote support, endpoint visibility, collaboration, knowledge, and an AI copilot in one coherent, fast, keyboard-driven product.

**North-star statement:** a technician resolves an incident — from request to documented resolution — without leaving ReyDesk and without retyping what the platform already knows.

**Positioning:** "The ticket *is* the troubleshooting console." For SMB IT teams and MSPs that need enterprise-grade remote support and auditability without enterprise weight.

## 2. Product principles (binding)

1. **Fast** — dashboard < 2 s; interactions feel instant; remote connect target < 5 s.
2. **Technician-first** — optimise the 20 actions done 50×/day, not the 200 done once.
3. **Three clicks, not fifteen.** Every workflow audited against click/friction budget.
4. **Secure by design** — zero-trust remote access, consent enforcement, complete audit trail (see `06-threat-model.md`).
5. **AI on a leash** — AI summarises, drafts, detects patterns; humans decide and execute.
6. **Multi-tenant from day one** — tenant isolation is an invariant, not a feature.
7. **API-first** — every screen's capability exists as an API.
8. **Modular monolith** — clean domain boundaries, no premature microservices.
9. **Honest states** — loading/empty/error states everywhere; no silent failures.

## 3. Personas

### P1 — Ada, Service Desk Analyst (L1), age 26
Works queue, phones, chat. Handles password resets, basic incidents, triage. Needs: instant user/device lookup, account-state visibility, one-click escalation, canned responses, KB suggestions. Frustrated by: switching to AD portal, writing notes after calls, SLA surprises.

### P2 — Marcus, Desktop Engineer (L2), age 34
Hands-on device troubleshooting; multiple remote sessions/day. Needs: device telemetry before connecting, reliable reboot-reconnect, terminal + approved scripts, file transfer, multi-monitor, session transfer to colleagues. Frustrated by: buried toolbar functions, post-session admin, reconnect failures.

### P3 — Priya, IT Manager, age 41
Runs a 6-person team. Needs: queue/workload/SLA overview, approvals, staffing decisions from data, audit evidence for ISO/SOC reviews. Frustrated by: reports that need exporting to Excel, technicians rushing tickets for metrics.

### P4 — Tomas, MSP Technician, age 29
Supports 8 customer tenants. Needs: clear tenant switching (never work on the wrong customer), per-customer permissions/branding/SLAs, cross-customer queue. Frustrated by: tools that blur tenant boundaries, per-customer logins.

### P5 — Sofia, End User, age 38, non-technical
Reports problems via portal/chat, responds to technician questions, consents to remote sessions. Needs: dead-simple portal, clear consent screens ("who is connecting and what can they do"), visible progress. Distrusts: unexplained admin actions, jargon.

### P6 — Daniel, Security Auditor, age 45
Quarterly evidence reviews. Needs: tamper-evident audit of every remote connection, command, file transfer, permission change; session recordings per policy; exportable reports. Cares about: attribution, retention, least privilege.

## 4. Core user journeys (must feel exceptional)

### J1 — "My laptop can't connect to the VPN" (attended remote)
1. Ticket arrives via portal/email. Automation classifies → network, assigns Desktop Support, links user's laptop from inventory.
2. Ada opens ticket: single workspace shows user panel, device panel (online, OS, network state), previous VPN tickets, known VPN incident banner, KB suggestions.
3. AI summary + suggested diagnosis (e.g. DNS failures in device diagnostics). Ada runs an approved *Network diagnostics* script — result posts into timeline.
4. Deeper work needed → Ada clicks **Remote Control** → user gets consent prompt (technician name, org, permissions) → grants view+control.
5. In-session: terminal → diagnostic commands (each audited) → restart network service → verify. Session dock persists while she checks KB in another tab.
6. End session → ReyDesk drafts structured notes (duration, commands, changes) from actual activity → Ada reviews, edits, clicks **Resolve**.
7. AI offers: "Create a knowledge article from this resolution?" → draft created, queued for approval.

### J2 — "I'm locked out" (identity context)
1. Call arrives; technician searches name → user profile shows account state (locked), MFA status, recent sign-in events, assigned devices, open tickets (via Entra ID integration where configured).
2. Authorised technician initiates the approved unlock workflow; MFA step-up required; action audited; ticket auto-created and updated with outcome.

### J3 — "Server disk at 4%" (monitoring → automated remediation loop)
1. Agent telemetry trips threshold → alert auto-creates ticket in Infrastructure queue with device health snapshot.
2. Engineer sees disk usage, largest directories, recent changes on the ticket.
3. Opens elevated terminal (policy-approved, reason recorded), runs approved cleanup script.
4. Telemetry confirms recovery; automation marks resolved with diagnostic summary; SLA clock stopped.

### J4 — Shift handover
Outgoing shift opens Handover view: critical/VIP open items, active major incidents, pending vendor responses, live sessions, SLA risks + AI-generated shift summary. Incoming shift claims items.

## 5. Functional requirements by phase

**MVP (Phase 1)** — full detail in `12-roadmap.md`:

| Area | Requirements |
|---|---|
| Identity & tenancy | Email+password auth, MFA (TOTP), organisations (tenants), invite flow, session management, RBAC core roles |
| Ticketing | Ticket CRUD; types incident/request/question/problem; statuses; priority/impact/urgency; requester/affected user; assignee/team; tags; watchers; attachments; internal notes vs public replies; activity timeline; SLA policies (response/resolution, business hours); canned responses; bulk ops; CSV export |
| Channels | Technician portal, customer portal, email-to-ticket (IMAP), API |
| Devices | Agent registration, identity, heartbeat, online/offline, inventory (HW/SW/OS/security posture), device detail page, alerts (offline, low disk, etc.) |
| Remote support | Attended (code+link+consent), unattended (policy-gated), browser console: view/control, multi-monitor, quality/bandwidth modes, clipboard, Ctrl+Alt+Del, terminal (PowerShell/cmd/shell, logged), file manager (upload/download/browse), process manager, service manager, reboot + auto-reconnect, session chat, invite/transfer technician, recording (policy), full session audit |
| Ticket↔session integration | Sessions linked to tickets; actions posted to ticket timeline; AI-drafted session notes (review-gated) |
| Knowledge base | Articles (rich text), folders, internal/external visibility, search, versioning |
| Automation | Trigger→condition→action rules (assignment, notification, priority, tags, webhook) |
| Notifications | In-app + email, per-user preferences |
| Reporting | Operational dashboards (volume, SLA, backlog, workload, session activity) |
| Audit | Tamper-evident log of auth, ticket changes, remote connections, commands, file ops, permission changes |
| Search | Universal search across tickets/users/devices/KB |
| Command palette | Ctrl+K navigation + actions |

**Phase 2:** asset management (CMDB-lite), service catalogue + approvals, problem & change management, script library w/ approvals + software deployment, endpoint monitoring rules, Microsoft 365/Entra integration (account actions), on-prem Active Directory integration (LDAP/ADSI directory sync + gated account actions — reset password, unlock, enable/disable), AI assistant (summaries, similar-incident detection, KB drafting), telephony hooks, teams chat.

**Phase 3:** full CMDB, MSP mode (cross-tenant console, per-customer branding/SLAs), major incident command centre, JIT privileged access, advanced analytics, patch management, compliance dashboards, Teams/Slack deep integration, webhooks marketplace.

**Phase 4:** RMM-grade endpoint management, DEX, security posture integrations, AI Level-1 agent (bounded tools + human approval), mobile remote support, developer API ecosystem.

## 6. Non-functional requirements

| Category | Requirement |
|---|---|
| Performance | Dashboard initial load < 2 s (p75); ticket ops < 200 ms API p95; remote connect < 5 s normal conditions; input latency ≤ 100 ms perceived on good links; lists virtualised/paginated |
| Scalability | 10k tenants, 100k devices (long-term); initial remote plane sized for 500 concurrent WebSocket connections and 50 simultaneous remote sessions, horizontally scalable to thousands per region (see `04-system-architecture.md` §5) |
| Availability | Control plane 99.9 %; relay plane redundant-pair failover initially (regional failover at scale); sessions survive broker restart (re-broker) |
| Security | TLS 1.2+ everywhere; DTLS-SRTP media; short-lived tokens; MFA; zero-trust connection evaluation; see threat model |
| Privacy/compliance | GDPR/UK GDPR data-subject flows; retention policies; data residency by region; ISO 27001 / SOC 2 aligned controls |
| Accessibility | WCAG 2.1 AA; full keyboard operation; visible focus; screen-reader labels on all interactive elements |
| Auditability | Append-only, hash-chained audit log; immutable recordings storage (WORM-style lifecycle) |
| Observability | Structured logs, metrics, traces; session QoS telemetry (connect time, fps, RTT, loss) |
| Compatibility | Technician console: current Chrome/Edge/Firefox/Safari. Agent: Windows 10+/Server 2016+, macOS 12+, major Linux distros |

## 7. Success metrics

- **Adoption:** % of ticket resolutions with ≥1 linked artifact (session/note/script) — target > 60 %.
- **Efficiency:** median first response < 15 min; MTTR improvement vs baseline; sessions per technician/day without overtime signal.
- **Quality:** reopen rate < 5 %; CSAT ≥ 4.5/5; KB deflection measurable at portal.
- **Safety:** 100 % of remote sessions fully attributed and audited; 0 consent bypasses.
- **Anti-gaming:** workload views show complexity + CSAT alongside volume (no raw ticket-count leaderboards).

## 8. Open questions / risks

| # | Item | Disposition |
|---|---|---|
| 1 | Windows attended without any preinstalled helper — OS constraints may force a lightweight signed helper download | Accept helper download with clear consent; design for minimal footprint |
| 2 | iOS/Android support | Out of scope until Phase 4 |
| 3 | Telephony provider choice | Defer; design webhook/CTI abstraction now |
| 4 | Self-hosted relay demand | Architecture keeps relay plane separable; decide Phase 3 |
| 5 | Pricing validation | See §9 |

## 9. Commercial model (initial recommendation)

Per-technician SaaS with endpoint allowance, mirroring mid-market expectations (Halo/Freshservice/ScreenConnect price bands, roughly $25–$60/technician/month by tier):

| Tier | Includes |
|---|---|
| **Team** | Ticketing, portal, KB, automations, attended + unattended remote (up to N endpoints), session audit |
| **Business** | + ITSM modules (problem/change/catalogue), script library, monitoring rules, AI copilot, reporting |
| **Enterprise/MSP** | + multi-customer MSP console, JIT elevation, compliance exports, SSO/SCIM, data-residency options |

Pricing levers kept simple: technicians + managed endpoints. AI included in Business+ (usage caps, not metered pricing, to avoid mistrust).
