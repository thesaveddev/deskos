# 01 — Competitive Analysis & Product Research

Purpose: ground DeskOS in what actually happens in a technician's day, not in feature-list copying. Method: capability/workflow analysis of leading ITSM and remote-support products, with emphasis on friction, buried features, consent patterns, and enterprise controls. (Sources: vendor documentation, published admin guides, practitioner communities — r/sysadmin, r/msp, SpiceWorks, Gartner Peer Insights patterns. No fabricated statistics; qualitative claims below are industry-consensus observations.)

---

## 1. Products researched

**ITSM / Helpdesk:** ServiceNow, HaloITSM, Freshservice, Jira Service Management (JSM), Zendesk, ManageEngine ServiceDesk Plus (SDP), SysAid, TOPdesk, Ivanti Neurons, SolarWinds Service Desk.

**Remote support:** BeyondTrust Remote Support, AnyDesk, TeamViewer Tensor / Remote, ConnectWise ScreenConnect, Splashtop (SOS/Enterprise), Zoho Assist, LogMeIn Rescue, Microsoft Quick Assist, RustDesk.

---

## 2. Capability matrix — ITSM

| Capability | ServiceNow | HaloITSM | Freshservice | JSM | Zendesk | ManageEngine SDP | SysAid | TOPdesk | Ivanti | SolarWinds SD | **DeskOS MVP** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Incident / request / problem / change | ✅ full ITIL | ✅ full ITIL | ✅ strong | ✅ (ITSM add-on) | ⚠️ incident-centric | ✅ full ITIL | ✅ | ✅ full ITIL | ✅ | ⚠️ incident+change | Incident+request+problem+change (lean) |
| Technician workspace quality | ❌ dense, dated | ✅ modern | ✅ polished | ⚠️ Jira-shaped | ✅ polished | ⚠️ dated | ⚠️ | ⚠️ | ⚠️ | ⚠️ | **Primary design target** |
| Built-in remote control | ❌ integration only | ⚠️ integrations | ⚠️ via TeamViewer/Splashtop plugins | ❌ | ❌ | ⚠️ Desktop Central add-on | ✅ basic built-in | ⚠️ integrations | ⚠️ (own RMM lineage) | ⚠️ (Take Control add-on) | **✅ native, first-class** |
| Device/endpoint agent | ⚠️ via ITOM | ⚠️ integration | ❌ | ❌ | ❌ | ✅ (SDP+ME suite) | ✅ | ❌ | ✅ | ⚠️ | **✅ native agent** |
| Asset management / CMDB | ✅ deep | ✅ | ⚠️ basic | ⚠️ via Insight | ❌ | ✅ | ✅ | ✅ | ✅ | ⚠️ | Phase 2 (device inventory at MVP) |
| Knowledge base | ✅ | ✅ | ✅ Freddy AI | ✅ Confluence-linked | ✅ Guide | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP |
| Automation / workflow | ✅ powerful, complex | ✅ | ✅ visual | ✅ Jira automation | ✅ triggers | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ MVP (rules engine) |
| AI assistance | ✅ Now Assist | ✅ AI | ✅ Freddy | ✅ Atlassian Intel | ✅ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ | Phase 2 (scoped, practical) |
| Email-to-ticket | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP |
| Customer portal | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ MVP |
| MSP multi-customer | ⚠️ | ✅ | ⚠️ | ❌ | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | Phase 3 |
| Self-host option | ❌ | ✅ | ❌ | ✅ (DC) | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | Cloud-first; agent relay self-hostable later |
| SMB friendliness | ❌ enterprise | ✅ | ✅ | ⚠️ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | **Core requirement** |

## 3. Capability matrix — Remote support

| Capability | BeyondTrust RS | AnyDesk | TeamViewer Tensor | ScreenConnect | Splashtop | Zoho Assist | LogMeIn Rescue | Quick Assist | RustDesk | **DeskOS MVP** |
|---|---|---|---|---|---|---|---|---|---|---|
| Unattended agent | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Attended via code/link | ✅ jump client | ✅ | ✅ QuickJoin | ✅ | ✅ SOS | ✅ | ✅ | ✅ (6-digit code) | ✅ | ✅ |
| Browser technician console | ✅ | ⚠️ (app-first) | ⚠️ app-first | ✅ | ✅ | ✅ | ✅ | ❌ (app) | ❌ (app) | **✅ browser-first** |
| Ticketing integration | ⚠️ (basic, ITSM integrations) | ❌ | ⚠️ | ✅ ConnectWise-native | ⚠️ | ⚠️ Zoho Desk | ⚠️ | ❌ | ❌ | **✅ same workspace** |
| Reboot & auto-reconnect | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| Remote terminal | ✅ | ✅ | ✅ | ✅ (strong) | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ |
| File transfer | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ | ✅ |
| Process/service manager | ✅ | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ⚠️ | ✅ |
| Script execution w/ approval | ✅ (powerful) | ⚠️ | ⚠️ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ | ✅ (approved library) |
| Session recording | ✅ policy-driven | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ⚠️ | ✅ policy-driven |
| Elevation / credential vault | ✅ best-in-class JIT | ❌ | ⚠️ (privileged session via Tensor) | ⚠️ | ❌ | ❌ | ⚠️ | ❌ | ❌ | Phase 3 (JIT) |
| Consent UX | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ gold standard | ⚠️ | ✅ (attended) / policy (unattended) |
| Self-hostable relay | ❌ | ⚠️ enterprise | ❌ | ✅ | ⚠️ | ❌ | ❌ | ❌ | ✅ core feature | Later phase |
| Latency / fluidity reputation | ✅ | ✅ best | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ | Target: top-tier |
| Mobile device support | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | Phase 3+ |

---

## 4. What technicians actually do (frequency-weighted)

Synthesized daily workflow of a service desk / desktop engineer:

1. **Queue triage** — scan assigned + unassigned tickets, spot SLA risk and VIPs. (Constant, dozens/day.)
2. **Understand the request** — read thread, identify affected user/device. (Every ticket.)
3. **Communicate** — reply, ask for detail, coordinate timing. (Most tickets.)
4. **Diagnose at a distance** — check device online status, account state, recent changes, similar tickets/known errors — *before* bothering the user. (High-value, currently requires 3–5 separate tools.)
5. **Remote session** — attend (consent code) or unattended; view → control → terminal/scripts → files → reboot. (Several/day for desktop teams.)
6. **Post-session admin** — write notes, log time, update status, attach evidence. (Universally resented; often skipped → poor records.)
7. **Escalate / hand over** — to L2/L3, vendor, or next shift.
8. **Knowledge** — search before work, write after (rarely, unless frictionless).
9. **Approvals & requests** — service requests, change approvals, access grants.
10. **Reporting** — mostly managers; technicians need their own workload view.

## 5. Friction inventory (where competitors lose)

### 5.1 Cross-product context switching (the big one)
- ITSM tools integrate remote control as a plugin/launch-out (Freshservice→TeamViewer, SDP→Desktop Central, ServiceNow→3rd party). The session happens in another UI; nothing comes back automatically into the ticket beyond a log line.
- Remote tools with ticketing (TeamViewer, ScreenConnect) have shallow ticketing — no real SLA, ITIL, portal, or KB.
- **Result:** technicians mentally stitch together 4–6 systems. Every switch costs minutes and loses context (who, what device, what was tried).

### 5.2 Pre-session blindness
- Remote tools show the device only once connected. Technicians want, *before* connecting: is it online? who's logged on? OS/patch state? previous tickets on this device? known incident? Most tools provide none of this; ITSM tools have some but no device telemetry.

### 5.3 Post-session documentation debt
- Session recordings exist but are heavy to review. Structured automatic capture (commands run, services restarted, files moved, settings changed) is rare. ScreenConnect comes closest with its command log. Technicians skip notes; audit and knowledge suffer.

### 5.4 Consent & access friction
- Attended sessions often need downloads/installs on the user side (AnyDesk portable run is the good pattern; Quick Assist's preinstalled code entry is the gold standard for zero-install).
- Unattended access in consumer tools is a flat device list with weak policy (no device groups, no approval for sensitive hosts, no per-session reason).

### 5.5 Buried features (recurring complaints)
- Clipboard sync, file transfer, Ctrl+Alt+Del, display selection, bandwidth/quality control hidden in sub-menus (TeamViewer, AnyDesk).
- Session transfer/handover awkward or absent outside ScreenConnect/Rescue.
- Multi-monitor handling inconsistent.
- Reboot-reconnect unreliable without agent (Quick Assist dies on reboot).

### 5.6 Enterprise controls
- BeyondTrust is the reference: session recording policies, credential vault, JIT elevation, compliance reporting. But heavy, expensive, and the UX is enterprise-dense.
- Mid-market tools (Freshservice, SDP) lack recording policy granularity and real zero-trust evaluation of each connection.

### 5.7 ITSM-side friction
- ServiceNow/JSM: power at the cost of clicks and admin complexity; "15 clicks" is real.
- Zendesk: fast for tickets, weak ITIL/device concepts.
- Freshservice/Halo: best balance today; Halo particularly praised for speed and configurability. Lesson: **speed and sane defaults beat exhaustive configurability.**

### 5.8 AI that isn't gimmicky
What practitioners actually value (or would): summarising long threads; classifying/routing; detecting "18 similar tickets this morning"; drafting resolution notes and KB articles from real session data. What they distrust: chatbots blocking users from humans, autonomous remediation without audit, hallucinated "solutions" presented as fact.

---

## 6. What should be auto-captured vs. consented

**Auto-capture (server-side, from platform activity):** session start/end, participants, duration, device, ticket link, commands executed, scripts run, files transferred (names/sizes/directions), services changed, reboots, elevation grants, AI-drafted notes for review.

**Consent required (attended sessions):** view screen, input control, file transfer, clipboard access, elevation, reboot. Display technician identity + organisation + exact permissions requested before granting.

**Policy-gated (unattended):** device-group allowlists, role permission, MFA step-up, mandatory connection reason, user-visible on-screen notification banner, recording policy, optional manager approval for sensitive groups.

---

## 7. DeskOS opportunities (synthesis)

| Opportunity | Basis |
|---|---|
| **Unified workspace = the differentiator.** Ticket page *is* the troubleshooting console: user context, device telemetry, remote actions, KB suggestions, session transcript — one screen. | §5.1–5.3 |
| **Browser-first technician console.** No technician client install; works from any managed browser; persistent session dock so navigating away never kills a session. | AnyDesk/TeamViewer app-first vs Rescue/BeyondTrust web-first |
| **Zero-install attended sessions** where the OS allows (Quick Assist-style code on Windows; web link with explicit consent elsewhere). | §5.4 |
| **Automatic, structured session documentation.** Notes drafted from actual audited activity; technician reviews with one click. Turns resented admin into a confirmation step. | §5.3, §5.8 |
| **Pre-session intelligence.** Device health + history + similar incidents shown before connect. | §5.2 |
| **Honest AI.** Summarise, detect clusters, draft KB — always human-approved, never autonomous control in MVP/Phase 2. | §5.8 |
| **SMB-speed with enterprise rails.** Halo/Freshservice-level speed and simplicity + BeyondTrust-grade audit/recording/zero-trust policies, priced for SMB/MSP. | §5.6–5.7 |
| **Keyboard-first density.** Command palette, queue hotkeys, list+detail layouts — Linear/Raycast discipline applied to ITSM. | §5.7 |

## 8. Explicit non-goals (learned from competitors)

- Not a full RMM in MVP (patch deployment, large-scale telemetry) — avoid ManageEngine-style sprawl early.
- No consumer file-sharing/backup/VPN upsell junk (TeamViewer lesson).
- No autonomous AI device control without explicit, bounded, audited tool permissions — ever.
- No feature-parity checklist competition with ServiceNow; compete on the technician's daily experience.
