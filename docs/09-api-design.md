# 09 — API Design

## 1. Conventions

- **REST over HTTPS**, JSON; base `/api/v1`. Versioned by path; breaking changes require new version.
- Auth: `Authorization: Bearer <access_jwt>` (15 min) + refresh flow at `POST /auth/refresh` (rotating refresh, httpOnly cookie on web). API keys for service accounts (`X-ReyDesk-Key`). OAuth2 client-credentials in P2.
- Tenant scoping: from membership + `X-ReyDesk-Tenant` header (MSP) or portal host. Exactly one tenant per request; cross-tenant references are 404, not 403.
- Errors: `{ "error": { "code": "permission_denied", "message": "...", "denied_reason": "mfa_stepup_required" } }` with stable machine codes.
- Pagination: cursor-based (`?cursor=&limit=`), default 50, max 200. Sorting whitelisted per endpoint.
- Idempotency: `Idempotency-Key` honoured on POSTs that create side-effects (tickets, sessions, automations).
- Rate limits per key/tenant: 600 rpm default; stricter on auth (5/min lockout ladder) and session creation. `429` with `Retry-After`.
- Validation: zod schemas shared via `packages/shared` → OpenAPI generated from route schemas (single source of truth).
- Webhooks out: signed (HMAC-SHA256, per-endpoint secret), at-least-once, replay window 5 min, deliveries logged.

## 2. Key endpoints (MVP)

### Auth & identity
```
POST   /auth/signup            POST  /auth/login           POST /auth/logout
POST   /auth/refresh           POST  /auth/mfa/enable      POST /auth/mfa/verify
GET    /me                     PATCH /me                   GET  /me/permissions
```

### Tenants & members
```
POST   /tenants                         GET   /tenants/:id
POST   /tenants/:id/members             PATCH /members/:id     DELETE /members/:id
GET    /teams      POST /teams          PATCH /teams/:id
```

### Tickets
```
GET    /tickets?status=&team=&assignee=&q=&sla_risk=&cursor=
POST   /tickets                         GET   /tickets/:id
PATCH  /tickets/:id                     POST  /tickets/:id/assign
POST   /tickets/:id/status              POST  /tickets/:id/reply      (public|internal)
POST   /tickets/:id/notes
POST   /tickets/:id/links               POST  /tickets/:id/tasks
POST   /tickets/:id/approvals/:aid/decide
POST   /tickets/:id/time                POST  /tickets/:id/watch
POST   /tickets/bulk                    GET   /tickets/export.csv
GET    /tickets/:id/timeline?cursor=
```

### Directory & users
```
GET    /contacts?q=                     GET   /contacts/:id
GET    /contacts/:id/tickets            GET   /contacts/:id/devices
```

### Devices
```
GET    /devices?group=&status=&q=       GET   /devices/:id
GET    /devices/:id/inventory           GET   /devices/:id/metrics?window=
GET    /devices/:id/tickets             GET   /devices/:id/sessions
POST   /devices/:id/quarantine          POST  /devices/:id/restart   (policy-gated)
GET    /device-groups     POST /device-groups   PATCH /device-groups/:id
POST   /enrolment-codes                 POST  /agents/enrol   (agent-side, code→cert)
```

### Remote sessions
```
POST   /sessions                  { deviceId | sessionCode, ticketId?, permissions[], reason }
                                  → 201 { sessionId, joinTicket } | 409 consent_pending
POST   /session-codes             → attended code+URL for a contact (email/SMS send optional)
GET    /sessions?state=           GET  /sessions/:id
POST   /sessions/:id/invite       POST /sessions/:id/transfer
POST   /sessions/:id/end          POST /sessions/:id/restart-device
GET    /sessions/:id/events       GET  /sessions/:id/recording
POST   /sessions/:id/notes/finalise   (approve AI-drafted notes → ticket thread)
```

### Broker WebSocket protocol (`wss://relay.reydesk.com/ws`)
Message envelope: `{ "v":1, "sid": "<session>", "type": "...", "payload": {...} }`

| type (client→broker) | purpose |
|---|---|
| `join` | present join ticket → admitted to session room |
| `sdp`, `ice` | relayed SDP/ICE between peers |
| `chat`, `note` | session presence channel messages |
| `consent.update` | end-user consent change (agent-side) |
| `heartbeat`, `state` | agent state transitions (booting/offline/restart-requested) |

Broker→client: `joined`, `peer_left`, `sdp/ice` (relayed), `session.state`, `participant.joined/left`, `recording.started`, `policy.denied {reason}`.

### Knowledge
```
GET    /kb/articles?q=&folder=&visibility=    POST /kb/articles
GET    /kb/articles/:id                        PATCH /kb/articles/:id
POST   /kb/articles/:id/publish                POST /kb/articles/:id/feedback
```

### Automation / notifications / reports / audit
```
GET/POST /automations           PATCH /automations/:id    GET /automations/:id/runs
GET      /notifications         POST  /notifications/read
GET      /reports/tickets?from=&to=&group_by=    (+ /sessions, /sla, /workload)
GET      /audit?action=&actor=&object=&cursor=   GET /audit/export.csv
```

### Email-to-ticket inbound
IMAP worker (internal): fetch → verify (SPF/DKIM, loop detection, tenant match by To/address mapping) → create ticket or append thread → mark processed. Admin endpoints configure mailboxes: `GET/POST /channels/email`.

## 3. Realtime (control-plane) WebSocket `/api/v1/realtime`

Authenticated socket per user; server pushes typed events; client subscribes implicitly by membership. Events (all tenant-scoped):

```
ticket.created/updated/resolved        ticket.reply_added
sla.warning / sla.breached             device.online / device.offline / device.alert
session.state_changed                  session.waiting (consent pending)
notification.new                       automation.ran
presence.team_changed
```

Client sends only `{ "type": "sub", "topics": [...] }`; everything else is server→client. Reconnect: exponential backoff + resume cursor to backfill missed events.

## 4. Public API guarantees

- Everything the UI does is expressible via API (parity is a review checklist item).
- OpenAPI 3.1 published per release; changelog maintained.
- Webhook events (MVP subset): `ticket.*`, `session.*`, `device.*`, `sla.*`.
