# ReyDesk

**The operating system for modern IT support.**

ReyDesk is a multi-tenant, AI-ready Helpdesk / ITSM platform with **first-class, built-in remote support** (remote desktop, terminal, file transfer, process/service management, script execution) — designed so that the ticket and the troubleshooting environment are the same workspace.

It is not a ticketing app with remote control bolted on. Every remote action is contextually linked to a ticket, attributed to a technician, consent-gated, and audit-logged.

---

## Status

- **Planning deliverables:** complete (`docs/01`–`docs/12`).
- **Phase 0 (scaffold):** complete — monorepo boots end-to-end via `npm run dev` (embedded Postgres + API + relay + web).
- **Phase 1 M1 (platform core):** implemented and tested — auth (signup/login/refresh-rotation/MFA-TOTP), multi-tenancy, RBAC, hash-chained audit log, notifications.
- **Phase 1 M2 (ticketing core + extras):** tickets CRUD + threads/timeline, status workflow, assignment, field updates with change tracking, tags, CSV export, universal search, queue counts; SLA engine (priority matrix, business hours, breach scheduler); customer portal endpoints; **file attachments** (upload/download, RLS-isolated); **⌘K command palette** (Ctrl/Cmd+K, fuzzy search, keyboard nav); **reports dashboard** (totals, bar breakdowns, avg response/resolution, 14-day sparkline); **email-to-ticket with per-tenant email channels** (each tenant configures their own IMAP inbox — credentials encrypted at rest, password masked, connection test + **test-before-add** + manual poll endpoints — mail routes into the owning tenant; create/thread/reopen, dedupe; legacy single-mailbox env mode kept as fallback). Technician UI: app shell, queue, ticket detail with reply/note composer + attachments, new-ticket form, reports page, **settings hub** (`/settings` — Basic org settings + Email channels).
- **Phase 1 M2 (customer portal SPA + canned responses + outbound email):** **customer portal SPA** (`/portal`, `/portal/new`, `/portal/tickets/:number`) — my-requests list, new-request form, ticket timeline with requester reply, **mark-as-resolved** (requester-only, idempotent, system event + audit + assignee notification; replying after resolve reopens the request); **canned responses** (tenant-scoped CRUD via `/settings/canned`, `canned.read`/`canned.manage` permissions, searchable picker with template insertion in the technician composer); **outbound reply-by-email** (nodemailer SMTP via `REYDESK_SMTP_*`, sends `Re: [#N]` on public replies and `Resolved: [#N]` on resolve/close, no-op + debug log when SMTP unset so ticket ops never fail).
- **Test suite:** 102 passing (auth, MFA, refresh-reuse, RBAC, DB-level RLS isolation, rate limiting, tickets, SLA math + breach detection, portal isolation + requester resolve/reopen, attachments upload/download/cross-tenant denial, reports, email parser + email-to-ticket create/thread/reopen/dedupe + email channels CRUD/isolation/masking/encryption + pre-save connection test + outbound mailer capture/no-op, canned responses CRUD/RBAC/duplicate/search/RLS, tenant settings read/update/slug-conflict/RBAC).

## Quickstart

```powershell
npm install
npm run dev      # db + api + relay + web, concurrently (Ctrl+C stops all)
```

Then open **http://localhost:5180** (API health: http://localhost:4000/healthz).
Full instructions, env vars, and troubleshooting: [`docs/00-running-locally.md`](docs/00-running-locally.md).

```powershell
cd apps\api
npm test         # 102 tests: auth, RBAC, RLS isolation, rate limiting, tickets, SLA, portal, attachments, reports, email-to-ticket, email channels, tenant settings, canned responses, outbound email
```

## Documentation index

| # | Document | Contents |
|---|----------|----------|
| 01 | [Competitive analysis](docs/01-competitive-analysis.md) | Research across 10 ITSM + 10 remote support products; capability matrix; friction points; gaps ReyDesk exploits |
| 02 | [Product requirements (PRD)](docs/02-prd.md) | Vision, principles, personas, core user journeys, functional + non-functional requirements, success metrics |
| 03 | [Information architecture](docs/03-information-architecture.md) | App structure, navigation, command palette, contextual panels, persistent session dock, keyboard model |
| 04 | [System architecture](docs/04-system-architecture.md) | Modular monolith, domain boundaries, Fastify vs Express and PostgreSQL vs MongoDB decisions, multi-tenancy, infra topology |
| 05 | [Remote support architecture](docs/05-remote-support-architecture.md) | Agent ↔ broker ↔ console connection flow, WebRTC/relay design, codecs, reboot-reconnect, elevation, recording |
| 06 | [Threat model](docs/06-threat-model.md) | STRIDE analysis, zero-trust connection evaluation, safety constraints |
| 07 | [Data model](docs/07-data-model.md) | Core PostgreSQL schema |
| 08 | [Permission model (RBAC)](docs/08-rbac.md) | Roles, permissions, scopes, remote-access policies, MSP model |
| 09 | [API design](docs/09-api-design.md) | REST conventions, key endpoints, realtime event contracts, webhooks |
| 10 | [Endpoint agent specification](docs/10-agent-spec.md) | Agent responsibilities, protocol surface, update security |
| 11 | [UI design system](docs/11-design-system.md) | Visual identity, tokens, components, accessibility |
| 12 | [Roadmap](docs/12-roadmap.md) | Phased implementation plan with exit criteria |

## Planned repository layout

```
deskos/
├── apps/
│   ├── web/        # Technician console + portal (React + Vite + TypeScript)
│   ├── api/        # Modular monolith (Node.js + Fastify + TypeScript, PostgreSQL, Redis)
│   ├── relay/      # Session broker + TURN/relay plane (separate failure domain)
│   └── agent/      # Endpoint agent (Rust; Windows/macOS/Linux)
├── packages/
│   ├── shared/     # Shared types/schemas (zod) between web/api/agent contracts
│   └── ui/         # Design system components
└── docs/           # This documentation set
```

## Guiding principles

1. **One workspace.** Ticket + device + session + knowledge + collaboration in a single context.
2. **Technician-first speed.** Keyboard-driven, high-density, instant-feeling UI.
3. **Secure by design.** Zero-trust remote access, consent enforcement, complete auditability.
4. **AI with a leash.** AI summarises, suggests, drafts — a human always approves and executes.
