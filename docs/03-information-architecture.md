# 03 — Information Architecture

Design rule: **context follows the object, not the module.** Every primary object (ticket, user, device, session) renders its own full context; modules are lenses, not silos.

## 1. Application shell

```
┌──────────────────────────────────────────────────────────────────────┐
│ Tenant switcher (MSP) · Org name            ⌘K search  · bell · me  │  Top bar
├────────────┬─────────────────────────────────────────────────────────┤
│ Nav rail   │  Active workspace (tickets / device / user / session…)  │
│            │                                                         │
│ Home       │                                                         │
│ Tickets    │                                                         │
│ Devices    │                                                         │
│ Sessions   │                                                         │
│ Knowledge  │                                                         │
│ Assets*    │                                                         │
│ Automations│                                                         │
│ Reports    │                                                         │
│ Admin      │                                                         │
├────────────┴─────────────────────────────────────────────────────────┤
│ Session dock (persistent, collapsible): active remote session(s)      │
└──────────────────────────────────────────────────────────────────────┘
```

- **Nav rail** — compact icon+label rail (collapsible to icons). Badges: unassigned count, SLA risk count, waiting sessions.
- **⌘K command palette** — universal search + actions (see §5).
- **Session dock** — bottom bar listing live/waiting remote sessions with latency + duration; click to restore full console. Sessions survive navigation (WebRTC state held in a dedicated console context, never unmounted on route change). *This is the "persistent technician console" requirement.*
- **Toasts/notifications drawer** — right-side, grouped, dismissible.

## 2. Primary routes

| Route | Purpose |
|---|---|
| `/home` | Technician workspace (§3) |
| `/tickets`, `/tickets/:id` | Queue + ticket workspace (§4) |
| `/queues/:teamId` | Team queue views |
| `/devices`, `/devices/:id` | Fleet + device context (§6) |
| `/users`, `/users/:id` | Directory + user context (§6) |
| `/sessions`, `/sessions/:id` | Session list/history + live console |
| `/knowledge`, `/knowledge/:articleId` | KB |
| `/assets` (P2) | CMDB |
| `/automations`, `/scripts` (P2) | Rules + script library |
| `/reports` | Dashboards |
| `/admin/*` | Org settings, teams, roles, SLAs, channels, integrations, audit log, billing |
| `/handover` (P2) | Shift handover |
| Portal: `/portal/*` | End-user portal (separate shell: my tickets, request, KB, status, **Get remote help**) |
| Attended: `/connect/:code` | End-user consent page (device-side web consent or agent UI) |

## 3. Home — technician workspace

Single scrollable dashboard, dense, sectioned:

1. **Needs attention** — SLA-breaching/soon, user replies, pending approvals.
2. **My open tickets** (compact table, sortable, hotkeys).
3. **Unassigned queue** preview with one-click claim.
4. **Live/waiting remote sessions** strip.
5. **Device alerts & outages** strip.
6. **Recently accessed** users/devices (recency = empathy for "the person I called 10 minutes ago").
7. **Team** — mentions, messages, on-shift roster (P2).

Empty states explain how to get data (e.g. "No devices yet — deploy the agent").

## 4. Ticket workspace (the flagship screen)

Three-column layout, resizable, collapses to two/one on narrow screens:

```
┌─────────────── Conversation ────────────────┬── Context rail ──┐
│ AI summary banner (collapsible)             │ User panel       │
│ Thread: customer messages / replies /       │ Device panel     │
│ internal notes / system events /            │ (or "Link device")│
│ attachments / session records               │ SLA panel        │
│                                             │ Related: linked  │
│ [Reply] [Internal note] [Resolve ▾]         │ tickets/KB/assets│
│ AI actions: Summarise · Suggest · Draft KB  │ Approvals/tasks  │
├─────────────────────────────────────────────┴──────────────────┤
│ Properties bar: status · priority · assignee · team · type ·   │
│ category · tags · device · watchers        (all inline-edit)   │
└────────────────────────────────────────────────────────────────┘
```

- **Conversation** is the single chronological truth: messages, notes, automations, sessions (rendered as compact session cards: duration, participant, outcome, "View transcript/recording").
- **Device panel actions** (prominent, top of panel): Remote Control · Terminal · Files · Processes · Services · Run script · Restart · Chat with user. Each gated by RBAC + device policy; disabled states explain *why*.
- **Context rail** is generated from the ticket's linked objects; everything cross-links (click user → user context; click device → device context).
- Keyboard: `r` reply, `n` note, `s` status, `a` assign, `1..4` switch composer mode, `?` shortcut help.

## 5. Command palette (⌘K)

Modes: **Go** (routes/objects), **Do** (actions), **Find** (search). Fuzzy + typed filters: `t:` tickets, `u:` users, `d:` devices, `k:` KB, `#` tags.

Actions: create ticket, claim next in queue, assign to…, set status, start remote session (device picker), run script (device picker), open queue, invite technician, toggle theme. Recent + pinned items. Everything the palette does is also available via menus (a11y).

## 6. Object context pages

**User page:** identity header (VIP flag, dept, manager, timezone, account status) → tabs: Tickets · Devices · Sessions · Activity · (P2: Account/Entra data). Actions: create ticket, start chat, message.

**Device page:** health header (online dot, OS, last seen, agent version, logged-in user) → tabs: Overview (CPU/RAM/disk/uptime/IP/network) · Software · Processes* · Services* · Tickets · Sessions · Inventory · Alerts. (*live views open in a lightweight "inspection session" — a non-interactive telemetry channel, not a full remote session.) Actions: Remote Control · Terminal · Files · Restart.

**Session console:** toolbar (fit/fullscreen · display selector · quality · Ctrl+Alt+Del · clipboard · files · terminal · processes · services · sysinfo · scripts · chat · notes · invite/transfer · record · reboot ▾ · end) + canvas + side panel (chat/notes/tools). Toolbar grouped by frequency; overflow menu only for rare items. All session actions attributable; reason-for-connection shown in session header for unattended.

## 7. Admin area

Settings → Organisation · Teams & members · Roles & permissions · SLA policies · Business hours/holidays · Ticket config (categories, statuses, priorities) · Channels (email, portal) · Automations · Scripts (P2) · Devices & agent deployment · Security (MFA policy, session policies, recording policies, audit log) · Integrations · Billing.

Audit log viewer: filterable, exportable, hash-chain verified.

## 8. Keyboard model (summary)

| Key | Scope |
|---|---|
| `⌘K` | Global palette |
| `g then t/d/s/k/h` | Go tickets/devices/sessions/knowledge/home |
| `c` | New ticket |
| `j/k` | List navigation |
| `x` | Select row (bulk) |
| `e` / `r` / `n` | Open / reply / note on selected ticket |
| `u` | Claim selected unassigned |
| `⇧R` | Resolve |
| `?` | Shortcut overlay |

All shortcuts redefinable later; focus rings always visible (WCAG).

## 9. Notification & interruption policy

- One notification per *event*, deduplicated per object (no 5 pings for one automation chain).
- In-app + email minimum; push/SMS/Teams later, opt-in.
- Quiet-hours per user; SLA-breach alerts exempt by policy.
