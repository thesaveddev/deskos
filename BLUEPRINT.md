# ReyDesk Blueprint

> Last updated: 14 September 2026
> Based on: ITSM/ESM Market Briefs (24 Aug - 14 Sep 2026)

---

## Part 1: Market Brief Summary

### What the market is saying right now

The ITSM market is moving from "AI-assisted ticketing" to **governed autonomous service operations**. The competitive shift is no longer who has a chatbot — it is who can safely take action across workflows, systems, and knowledge while proving the outcome.

### Key competitor moves

| Vendor | What they did | Why it matters |
|--------|--------------|----------------|
| **ServiceNow** | September release: first out-of-the-box L1 Service Desk AI Specialist. Diagnoses, fixes, escalates, documents. Requires Pro Plus / Enterprise Plus. Consumes "assists" based on usage. | The benchmark is now "show me the work your AI can autonomously complete." |
| **ServiceNow** | AI Gateway (AI Control Tower): runtime enforcement layer between AI agents and MCP servers. Central tool catalogue, policy enforcement, activity visibility. | Enterprise buyers will ask: "Who authorised it, what data did it access, what tool did it call, and can I prove what happened?" |
| **Atlassian** | AI agents for CSM: $1 per successfully resolved customer inquiry from Dec 2026. No included allowance. Failed escalations not charged. | Outcome-based pricing is becoming mainstream SaaS commercial model. |
| **Freshservice** | Named Leader in Gartner 2026 Magic Quadrant. Promoting MCP integration with Claude, Gemini, Copilot Studio. Unified ITSM + ITOM + ITAM + ESM. Under 90-day implementation. | The service-management app is becoming the backend system of record, not necessarily the user's interface. |
| **Zendesk** | Employee Service AI agents in Slack, Teams, employee portal. Connects to SharePoint, Google Drive, Confluence. Automated-resolution pricing after Oct 2026 GA. | Zendesk is no longer purely customer-support — moving directly into IT/HR/employee-service. |
| **ManageEngine** | Zia Agents with own knowledge, tools, guardrails. Session-level observability (tool calls, LLM calls, token usage, success rates). BYOK support. | Enterprise buyers want control + model choice + auditability. |
| **HaloITSM** | No material September disruption. Still strong reference competitor for configurable ITSM/ESM. | The more dramatic movement is from ServiceNow, Atlassian, Freshworks, Zendesk, ManageEngine. |

### Enterprise buying signals

- AI training is the #1 planned technology investment for next 12 months (Liferay research, Sep 2026)
- 94% support AI on mainframe, but only 23% comfortable with AI acting independently (BMC survey, Sep 2026)
- **Lesson:** Buyers want autonomy, but controlled autonomy. Don't sell "our AI can do anything." Sell "our AI can perform approved IT work automatically, within policies you control."

---

## Part 2: ReyDesk Current Capabilities (What We Have)

### Core platform
- Remote support (WebRTC, consent-first, Windows/Android, relay, TURN, session recording)
- Ticketing with SLA tracking, service catalogue, approvals, change management, problem management
- Endpoint management / RMM (device inventory, monitoring, alerts, patches, DEX scoring, security posture)
- Knowledge base
- Audit log (hash-chained, tamper-evident)
- Compliance scoring and export
- Multi-tenant MSP console
- Billing (Stripe, manual, subscriptions)
- Reporting (sessions, tickets, agents, CSAT, compliance, AI workers)

### AI layer
- AI triage (auto-triage, auto-reply, auto-resolve with confidence threshold)
- AI workers (L1 service desk: plan → execute → resolve/handoff, approval gates, step timeline)
- AI agent (bounded remediations: restart, inventory, scripts, notes)
- Knowledge graph context (user → device → asset → service enrichment for worker prompts)
- Alert scheduler (60s interval, device alert polling, auto-trigger workers)
- BYOK AI provider (managed + BYOK modes, model allowlist, encrypted API keys)
- AI usage tracking (requests, tokens, failures, time-series)
- AI worker metrics on Reports page (resolution rate, time saved, outcome donut, 30-day trend)
- AI worker webhooks (resolved, handoff, failed events)
- Retry/backoff on provider failures (3 attempts, exponential backoff)
- SLA exemption for worker-resolved tickets

### Integration layer
- OAuth2 + OpenAPI public API
- Webhooks (outgoing events)
- Telephony (Twilio, generic provider, click-to-call)
- Push notifications (web push)
- Email queue and templates
- Device agent dispatch (Rust agent polls pending actions)

### Approvals and governance
- Service/change/access approval workflows
- AI worker approval gates (high-risk steps require human approval)
- Tenant policy controls (enable/disable, auto-approve, max steps)
- Script approval workflow
- Audit trail for all actions

---

## Part 3: Gap Analysis — What We Need

### Priority 1: Production-grade L1 AI Worker (CRITICAL)

**Market context:** ServiceNow just shipped an out-of-the-box L1 Service Desk AI Specialist. This is now the competitive benchmark.

**What we have:**
- Worker engine with plan → execute → resolve/handoff lifecycle
- Approval gates and step timeline
- Knowledge graph context enrichment
- Alert-to-worker auto-trigger

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| Measurable outcome dashboard (X% resolved without human intervention) | Missing | P0 |
| Pre-built L1 playbooks (password reset, software install, printer, network) | Missing | P0 |
| Worker confidence scoring and escalation heuristics | Partial | P0 |
| End-user self-service trigger (user starts worker from portal) | Missing | P1 |
| Worker run replay and debug view | Basic | P1 |
| Token/cost tracking per worker run | Missing | P1 |
| Provider retry/backoff | Done | — |
| Webhook events for outcomes | Done | — |
| SLA exemption for worker-resolved tickets | Done | — |

**Build actions:**
1. Create 5-10 pre-built L1 playbooks (common helpdesk requests)
2. Add worker confidence scoring to escalation decisions
3. Build outcome dashboard showing resolution rate, time saved, cost per resolution
4. Allow end-users to trigger AI worker from self-service portal
5. Add per-run token and cost tracking

---

### Priority 2: AI Governance Layer (CRITICAL)

**Market context:** ServiceNow's AI Gateway and ManageEngine's Zia observability show where enterprise expectations are heading. Buyers will ask: "Who authorised it, what data did it access, what tool did it call, and can I prove what happened?"

**What we have:**
- Approval gates for high-risk worker steps
- Audit trail for worker actions
- Tenant policy controls
- Tool risk tiers (low/high)

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| Centralised AI activity dashboard (all agent/worker/tool activity) | Missing | P0 |
| Per-tool permission matrix (which tools each role can enable) | Missing | P0 |
| Approval threshold configuration (auto-approve below X risk) | Partial | P0 |
| Data access logging (what data each AI action touched) | Missing | P0 |
| MCP tool catalogue (central registry of available AI tools) | Missing | P1 |
| Agent/session-level observability (tool calls, LLM calls, tokens, success rates per run) | Missing | P1 |
| AI governance export (compliance report for auditors) | Missing | P1 |

**Build actions:**
1. Build AI Governance dashboard showing all agent/worker activity with filters
2. Create per-tool permission matrix in Settings → AI
3. Add data access logging to every AI action
4. Build MCP tool catalogue endpoint
5. Add session-level observability (tool calls, tokens, timing per worker run)
6. Create AI governance export (PDF/CSV compliance report)

---

### Priority 3: MCP / External AI Client Integration (HIGH)

**Market context:** Freshservice is promoting MCP integration with Claude, Gemini, Copilot Studio. Zendesk agents work in Slack and Teams. The service-management app is becoming the backend, not the interface.

**What we have:**
- OAuth2 + OpenAPI public API
- Webhooks
- Knowledge graph context

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| MCP server endpoint (expose ReyDesk tools via Model Context Protocol) | Missing | P0 |
| Slack/Teams integration (AI agents in chat platforms) | Missing | P1 |
| External AI client auth (API keys for Claude, Gemini, Copilot) | Missing | P1 |
| Tool permission enforcement for external AI clients | Missing | P1 |
| Audit trail for external AI actions | Missing | P1 |

**Build actions:**
1. Build MCP server endpoint exposing ticket, device, KB, and asset tools
2. Add Slack integration (AI agent responds in Slack channels)
3. Add Teams integration (AI agent in Teams)
4. Create API key auth for external AI clients
5. Enforce tool permissions for external clients
6. Log all external AI actions in audit trail

---

### Priority 4: AI Consumption Economics (HIGH)

**Market context:** Atlassian is charging $1 per resolved inquiry. Outcome-based pricing is becoming mainstream. But ReyDesk should not copy blindly — SMEs need predictable economics.

**What we have:**
- AI usage tracking (requests, tokens, failures)
- Monthly request/token limits per tenant
- Plan-based entitlements

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| Cost per successful autonomous resolution tracking | Missing | P0 |
| AI usage included in plan tiers (not charged per resolution) | Partial | P0 |
| AI usage packs for high-volume autonomous resolutions | Missing | P1 |
| AI ROI calculator (time saved vs cost) | Missing | P1 |
| Usage alerts (approaching limits) | Missing | P1 |

**Build actions:**
1. Track cost per successful autonomous resolution
2. Design plan tiers: Business (fixed + AI included), Enterprise (larger AI allowance), AI Scale (usage pack)
3. Build AI ROI calculator showing time saved and cost per resolution
4. Add usage alert notifications when approaching limits
5. Create AI usage pack purchase flow

---

### Priority 5: Employee Service / ESM (MEDIUM)

**Market context:** Zendesk is pushing autonomous employee service in Slack/Teams. Freshservice has unified ITSM + ITOM + ITAM + ESM. ESM and AI are converging.

**What we have:**
- Service catalogue with approval workflows
- Ticketing
- Knowledge base

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| HR service management module | Missing | P1 |
| Facilities service management | Missing | P2 |
| Employee portal with AI assistant | Partial | P1 |
| Cross-department service workflows | Missing | P1 |
| Service catalogue categories (IT, HR, Facilities, Finance) | Missing | P2 |

**Build actions:**
1. Add HR service management (onboarding, offboarding, leave requests)
2. Add facilities service management (room booking, equipment requests)
3. Build employee portal with AI assistant for self-service
4. Create cross-department service workflows
5. Add service catalogue categories

---

### Priority 6: Model-Agnostic Architecture (MEDIUM)

**Market context:** ManageEngine offers BYOK with model choice. Enterprise buyers want control + model choice + auditability.

**What we have:**
- BYOK AI provider (managed + BYOK)
- Model allowlist
- Encrypted API keys
- Provider retry/backoff

**What we need:**

| Gap | Status | Priority |
|-----|--------|----------|
| Model selection per task type (triage vs worker vs KB) | Missing | P1 |
| Ollama/vLLM self-hosted support | Missing | P1 |
| Model performance comparison dashboard | Missing | P2 |
| A/B testing for model quality | Missing | P2 |

**Build actions:**
1. Allow different models for different AI tasks (triage, worker, KB drafting)
2. Add Ollama/vLLM self-hosted provider support
3. Build model performance comparison dashboard
4. Add A/B testing framework for model quality

---

### Priority 7: Competitive Differentiation (ONGOING)

**Market context:** Don't compete on feature count. Compete on faster deployment, lower implementation burden, simpler administration, transparent pricing.

**Current positioning:**
- "Get your service desk live in days, not months" (attack Freshservice's 90-day benchmark)
- Consent-first remote support (differentiator against all competitors)
- Tamper-evident audit log (differentiator)
- Simple pricing (no per-resolution charges)

**Build actions:**
1. Publish deployment time benchmarks (target: < 1 day for basic setup)
2. Create "Getting started in 5 minutes" interactive guide
3. Add deployment health checker (validates configuration)
4. Create competitor migration guides (ServiceNow, Freshservice, Zendesk → ReyDesk)

---

## Part 4: AI Pricing Strategy

Based on the market briefs, here is the recommended pricing approach:

### Don't copy Atlassian's per-resolution model

Atlassian charges $1 per successfully resolved CSM inquiry. This is too aggressive for SMEs and creates unpredictable bills.

### Recommended approach: Subscription + generous AI included

| Plan | Platform price | AI included | Overage |
|------|---------------|-------------|---------|
| **Business** | $79/tech/month | 500 AI resolutions/month | $0.50/resolution |
| **Enterprise** | Custom | 2,000 AI resolutions/month | $0.40/resolution |
| **AI Scale** | Add-on pack | 10,000 resolutions | $0.30/resolution |

**Key principles:**
- Predictable monthly cost
- Generous included allowance (most teams won't hit it)
- Overage is optional and transparent
- Track cost per resolution internally from day one
- Never charge for failed escalations or testing

---

## Part 5: Build Priority Roadmap

### Phase 1: Production-Grade AI Worker (Weeks 1-2)
- [ ] Pre-built L1 playbooks (password reset, software install, printer, network, account unlock)
- [ ] Worker confidence scoring and escalation heuristics
- [ ] Outcome dashboard (resolution rate, time saved, cost per resolution)
- [ ] End-user self-service worker trigger
- [ ] Per-run token and cost tracking

### Phase 2: AI Governance Layer (Weeks 2-3)
- [ ] AI activity dashboard (all agent/worker/tool activity)
- [ ] Per-tool permission matrix
- [ ] Data access logging
- [ ] Session-level observability (tool calls, tokens, timing)
- [ ] AI governance export (compliance report)

### Phase 3: MCP Integration (Weeks 3-4)
- [ ] MCP server endpoint (ticket, device, KB, asset tools)
- [ ] External AI client auth (API keys)
- [ ] Tool permission enforcement for external clients
- [ ] Audit trail for external AI actions

### Phase 4: AI Economics (Weeks 4-5)
- [ ] Cost per resolution tracking
- [ ] Plan tier AI allowances (Business, Enterprise, AI Scale)
- [ ] AI ROI calculator
- [ ] Usage alerts and notifications
- [ ] AI usage pack purchase flow

### Phase 5: ESM Expansion (Weeks 5-7)
- [ ] HR service management module
- [ ] Facilities service management
- [ ] Employee portal with AI assistant
- [ ] Cross-department workflows

### Phase 6: Model Flexibility (Weeks 7-8)
- [ ] Model selection per task type
- [ ] Ollama/vLLM self-hosted support
- [ ] Model performance dashboard

---

## Part 6: Competitive Positioning

### ReyDesk vs ServiceNow
- **ServiceNow:** Complex, expensive, requires consulting programme
- **ReyDesk:** Simple, affordable, deploy in days not months
- **Attack vector:** "Get your service desk live in days, not months. No consulting required."

### ReyDesk vs Freshservice
- **Freshservice:** 90-day implementation, $19-99/agent, Freddy AI at $29/agent extra
- **ReyDesk:** Under 1-day setup, $29-79/tech, AI included in plan
- **Attack vector:** "90 days is too long. Get live in a day."

### ReyDesk vs Zendesk
- **Zendesk:** Customer support focused, now moving into employee service
- **ReyDesk:** Built for IT from day one, consent-first remote support
- **Attack vector:** "Built for IT, not retrofitted from customer support."

### ReyDesk vs ManageEngine
- **ManageEngine:** Feature-rich but complex, Enterprise-only for AI agents
- **ReyDesk:** AI workers available on Pro plan, simpler administration
- **Attack vector:** "Enterprise AI features without the enterprise price tag."

### Key differentiators to protect
1. Consent-first remote support (enforced in agent code, not just UI)
2. Tamper-evident audit log (hash-chained)
3. Simple pricing (no per-resolution charges)
4. Fast deployment (< 1 day vs 90 days)
5. AI governance built-in (not an add-on)

---

## Part 7: Success Metrics

### AI Worker KPIs to track from day one
- Resolution rate (% of tickets resolved without human intervention)
- Time saved (estimated vs actual minutes per resolution)
- Cost per successful autonomous resolution
- Escalation rate (% handed off to human)
- User satisfaction (CSAT for worker-resolved tickets)
- Provider failure rate

### Business KPIs
- Time to deploy (target: < 1 day)
- AI adoption rate (% of tenants using AI features)
- AI usage per tenant (requests, tokens, resolutions)
- Revenue per AI resolution (for pricing optimization)

---

## Appendix: Market Brief Sources

1. ServiceNow September 2026 Release — L1 AI Specialist
2. ServiceNow AI Gateway / AI Control Tower — MCP enforcement layer
3. Atlassian AI Consumption Pricing — $1 per resolved inquiry
4. Freshservice Gartner 2026 Magic Quadrant Leader
5. Freshservice MCP Integration — Claude, Gemini, Copilot Studio
6. Zendesk Employee Service AI — Slack, Teams, automated-resolution pricing
7. ManageEngine Zia Agents — BYOK, session-level observability
8. Liferay September 2026 Research — AI training as #1 investment
9. BMC September 2026 Survey — Trust gap in AI autonomy
