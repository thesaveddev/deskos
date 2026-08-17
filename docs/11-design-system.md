# 11 — UI Design System

## 1. Design stance

DeskOS is an **operations console**, not a marketing site. Reference discipline: Linear (calm density), Raycast (keyboard speed), Stripe (component precision), modern GitHub (information hierarchy). Anti-goals: card-everything layouts, gradient/glass decoration, oversized type, badge soup, empty whitespace as "premium" signal.

**Rules:**
1. Density is a feature — technicians scan 50+ rows; earn every vertical pixel.
2. Hairlines > shadows; surfaces > cards. One elevation level for overlays only.
3. One accent colour; status colours reserved for status. Never decorative colour.
4. Data is set in mono; prose in sans. Numbers right-aligned, tabular.
5. Every screen has loading / empty / error / denied states, designed — not afterthoughts.
6. Motion: ≤ 150 ms, functional (state changes), never ornamental.

## 2. Identity — "Graphite Signal"

Dark-first console (light theme equal-citizen; dark is default for session consoles).

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg-0` | `#0e1114` | `#fafafa` | App ground |
| `--bg-1` | `#14181d` | `#ffffff` | Panels |
| `--bg-2` | `#1a2027` | `#f3f4f6` | Inset/hover |
| `--line-1` | `#242b33` | `#e4e7eb` | Hairlines |
| `--line-2` | `#303a45` | `#d0d5dc` | Strong dividers |
| `--text-1` | `#e6e9ec` | `#17191c` | Primary |
| `--text-2` | `#9aa4af` | `#5b6570` | Secondary |
| `--text-3` | `#5f6b77` | `#8b95a1` | Muted |
| `--accent` | `#e8a33d` | `#b07614` | **Signal amber** — actions, focus, selection (one accent only) |
| `--accent-hi` | `#f2b658` | `#8a5c10` | Hover |
| `--ok` | `#3fb27f` | `#1f7a55` | Online/resolved/success |
| `--warn` | `#d9a03c` | `#9a6d1a` | SLA risk/warning |
| `--crit` | `#e0564f` | `#b3261e` | Breach/critical/error |
| `--info` | `#5b9dd6` | `#2c6fad` | Informational links |

Rationale: amber-over-graphite reads "operations room", differentiates from the blue/purple SaaS default and from reydesk's warm-cream identity, keeps status colours unambiguous.

## 3. Typography

| Role | Font | Sizes |
|---|---|---|
| UI/prose | **IBM Plex Sans** (400/500/600) | 13 px base (console), 14 px forms/portal, headings 16/18/22/28 |
| Data/IDs/timestamps/code | **IBM Plex Mono** (400/500) | 12 px |

- Tracking: -0.01em above 18 px; never uppercase headings.
- Overline labels: mono, 10 px, letter-spaced, used sparingly (panel headers only).
- Line height 1.45 prose, 1.2 data rows.

## 4. Spacing & layout

- 4 px base unit; scale 4/8/12/16/24/32/48.
- Rows: table row 32 px (compact) / 36 px (default); form field 32 px; touch targets ≥ 32 px desktop, ≥ 44 px portal/mobile.
- Radius: 6 px controls, 8 px panels, 10 px overlays. No radius > 12 px.
- Grid: 8-col content max-width 1440 px for forms/reports; workspace screens fluid.
- Resizable ticket-workspace columns with persisted widths.

## 5. Component inventory (packages/ui)

Primitives: Button (primary/secondary/ghost/danger × sm/md), IconButton, Input, Select, MultiSelect, Checkbox/Radio/Switch, Tabs, SegmentedControl, Menu, Tooltip, Toast, Modal, Drawer, Kbd.

Domain components: StatusDot, PriorityMark (P1–P4 glyphs, colourblind-safe shapes), SLAPill (mono countdown; ok/warn/crit), TicketRow, QueueTable (virtualised), UserChip, DeviceChip (+online dot), SessionCard, TimelineEntry (+ kind icons: reply/note/session/automation), PermissionTag, ConsentDialog, SessionToolbar (+ grouped tool menus), CommandPalette, AuditTrailRow, DiffView (field changes), EmptyState, ErrorState, DeniedState (with actionable reason).

States are components: `<TableState status="loading|empty|error|denied" />` enforced by lint rule — no bare spinners.

## 6. Iconography

One icon set (Lucide, 16/20 px, 1.5 px stroke). Icons support labels, never replace them in nav. Remote toolbar uses icon+text tooltips with shortcut hints.

## 7. Accessibility (WCAG 2.1 AA, binding)

- Contrast ≥ 4.5:1 body, ≥ 3:1 large/UI; both themes audited (tokens chosen to pass).
- Visible focus: 2 px accent outline, 2 px offset — never disabled globally.
- Full keyboard operation: palette, tables (j/k), dialogs (focus-trapped), skip links.
- Screen readers: live regions for session state changes + SLA breaches; consent dialogs announced.
- Reduced-motion respected; colour never the sole status carrier (dot + shape/label).

## 8. Remote session console specifics

- Console defaults to dark regardless of theme (video contrast).
- Session HUD: bottom-left mono readout `32 fps · 41 ms · relay:eu-west`; toolbar top, grouped: View | Tools | Collaborate | Danger (reboot/end, visually set apart, confirm dialogs).
- Consent screen (end-user): plain language, large text, technician photo/name/org, per-permission toggles, single prominent Accept/Decline. No dark patterns.

## 9. Brand surfaces

Landing/portal share tokens but relax density (14–16 px, wider rhythm). Portal prioritises legibility for non-technical users: minimal chrome, three primary actions max per screen.
