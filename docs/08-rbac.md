# 08 — Permission Model (RBAC + scoped policies)

Model: **role-based permissions + scope constraints + explicit grants**, evaluated deny-by-default. Remote access has an additional policy layer (zero-trust gate, `05-§4`).

## 1. Permission grammar

`domain.action[:qualifier]` — e.g. `ticket.read`, `ticket.assign`, `remote.control`, `remote.elevated_terminal`, `script.execute:approved`, `device.restart`, `report.export`, `admin.roles.manage`.

Qualifiers narrow the action (`script.execute:approved` vs `script.execute:arbitrary`). Checks happen in service layer + API layer (belt & braces), never UI-only.

## 2. System roles (tenant level)

| Role | Ticketing | Devices/Remote | Admin | Notes |
|---|---|---|---|---|
| **Owner** | all | all | all incl. billing, danger zone | ≥2 required for MSP tenants |
| **IT Manager** | all, SLA config | view all, approve sensitive access | teams, roles, policies, reports | Can't edit billing |
| **Service Desk Manager** | all | attended + unattended laptops group | queue/SLA config | |
| **Service Desk Analyst (L1)** | own+team queues, reply, assign, escalate | attended control (laptops/desktops groups), inspection | — | No servers, no elevated terminal by default |
| **Desktop Engineer (L2)** | all incidents | unattended + elevated terminal (workstation groups), scripts:approved, device.restart | — | |
| **Infrastructure Engineer** | infra queues | servers/infra device groups, elevated, scripts:approved | — | |
| **Security Analyst** | read | view sessions/recordings, quarantine devices, kill switches | audit log, security policies | No routine remote control |
| **Change Manager / Problem Manager** | respective types manage | read | respective configs | |
| **Auditor** | read + exports | read recordings | audit log export | Read-only everywhere |
| **End User** | own tickets (portal) | consent actions only | — | Portal identity |
| **MSP Technician** | per-customer membership | per-customer policies | — | P3; active-tenant banner |
| **External Supplier** | assigned tickets only | specific approved devices only, attended-only, recorded | — | Time-boxed grants |
| **Platform Super Admin** | — | — | platform ops only, no tenant data without break-glass | Break-glass audited + dual control |

Roles are templates: orgs can clone and edit permission sets (custom roles, P2).

## 3. Scopes

Permissions are constrained by scope, evaluated as intersection:

- **Team scope** — queues/assignments limited to member teams (optional per role).
- **Device-group scope** — remote/device actions apply only to listed groups (e.g. "Workstations" not "Servers"). Dynamic groups via match rules (OS, OU, tag, name pattern) + manual members.
- **Data scope** — own / team / all (tickets, reports).
- **Time scope** — grants can carry `expires_at` (supplier access, temporary elevation).

## 4. Explicit grants & denials

`grants` table adds point overrides without editing roles: grant `remote.control` on `device_group:finance-servers` to one engineer for 48 h, with reason + approver. Denials override grants. All grant changes are audit-logged with actor + reason.

## 5. Remote-access policy matrix (org-configurable per device group)

| Setting | Options |
|---|---|
| Session types allowed | attended / unattended / inspection |
| Consent | required (attended) / notify-only (unattended) / notify + banner text |
| Reason for connection | optional / required |
| MFA step-up | never / always / sensitive-groups |
| Manager approval | never / always (async approval request) |
| Recording | off / optional / mandatory |
| Clipboard | disabled / enabled (audited) |
| File transfer | disabled / enabled / enabled with dir restrictions |
| Elevated terminal | disabled / permission-gated / + MFA step-up |
| Script execution | disabled / approved-only / + arg validation |
| Reboot allowed | yes/no; safe-mode reboot yes/no |
| Auto-reconnect after reboot | allowed / requires fresh consent |

## 6. Evaluation pipeline (request → decision)

```
API call → authn → tenant context → role permissions → scope intersection
→ explicit grants/denials → (remote: device-group remote_policy)
→ (remote: zero-trust gate incl. anomaly checks) → execute → audit
```

Denial responses include a machine-readable `denied_reason` so the UI can say exactly why a button is disabled ("requires MFA step-up", "outside your device groups").

## 7. Audit requirements

Every permission-sensitive action logs: actor, effective role, permission checked, scope, target, decision, reason, session/ticket context. Permission *changes* (role edits, grants) are additionally logged with before/after.

## 8. Default stance

- New technicians start with **read + ticket work only**; remote access must be explicitly granted.
- Every org ships with three device groups by default: Workstations, Servers, Sensitive (empty until populated) — Sensitive carries the strictest default policy (recording mandatory, reason required, manager approval).
- External/supplier access always expires; reminders at 80 % of lifetime.
