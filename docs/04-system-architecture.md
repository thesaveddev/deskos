# 04 — System Architecture

## 1. Shape: modular monolith + separate remote plane

```
                        ┌──────────────────────── Control plane ───────────────────────┐
 Browser (web SPA) ───▶ │  API monolith (Fastify + TS)                                  │
 Portal / Attended ───▶ │  ┌ identity ┐ ┌ tickets ┐ ┌ devices ┐ ┌ knowledge ┐ …        │
 Email (IMAP) ────────▶ │  └──────────┘ └─────────┘ └─────────┘ └───────────┘          │
                        │  PostgreSQL (system of record) · Redis (cache/queue/presence) │
                        │  S3 (attachments, recordings)                                 │
                        └───────────────┬──────────────────────────────────────────────┘
                                        │ internal API + events
                        ┌───────────────▼─────────────── Remote plane ─────────────────┐
 Endpoint agent ◀──WS──▶│  Session broker (auth, matchmaking, signalling)               │
 Browser console ◀─WS──▶│  TURN/relay nodes (redundant pair; regional only at scale)    │
                        └───────────────────────────────────────────────────────────────┘
```

**Why not microservices:** one team, one deployable unit keeps iteration speed; domains are enforced as internal module boundaries (each owns its tables, exposes only typed service interfaces + events). Extraction criteria are documented per domain (see §3) so a service can be split when a real scaling/team reason exists — not before.

**Why the remote plane is separate:** different failure modes, scaling profile (websocket-fanout + media), and security posture. A control-plane outage must not kill in-flight sessions (agents/console re-broker), and a relay incident must not take down ticketing.

## 2. Technology decisions

### Frontend — React + Vite + TypeScript (SPA)
- Technician console is an authenticated, stateful workspace; SSR buys nothing and adds ops complexity. Vite gives fast dev builds; code-split per route; console session kept in a root-level provider so navigation never tears down WebRTC.
- State: server state via TanStack Query; UI/session state via Zustand; realtime via socket layer. (Redux is unnecessary overhead for this shape.)
- Styling: design-token CSS (light + dark) + utility layer; headless accessible primitives (Radix) under custom components.

### Backend framework — Fastify over Express
| Criterion | Fastify | Express | Decision driver |
|---|---|---|---|
| Throughput/latency | ~2× under load (fewer middleware layers, compiled routes) | Good | Remote control plane does heavy WS fan-out; headroom matters |
| Schema validation | First-class JSON Schema + `@fastify/type-provider-zod` → request/reply types inferred | Manual middleware | One source of truth for API contract = fewer drift bugs |
| Plugin encapsulation | Scoped plugins, per-route hooks, decorators | App-global middleware by default | Fits modular monolith domain boundaries |
| WebSocket | `@fastify/websocket` (uWS-grade under the hood) | ws bolt-on | Broker is WS-heavy |
| Ecosystem maturity | Slightly smaller | Largest | Acceptable; all needed integrations exist |

**Decision: Fastify.** The validation + encapsulation model directly serves the modular-monolith requirement.

### Database — PostgreSQL over MongoDB
| Criterion | PostgreSQL | MongoDB | Decision driver |
|---|---|---|---|
| Referential integrity | FK constraints, deferrable | Application-enforced | Tickets↔users↔devices↔sessions↔SLA are deeply relational; integrity bugs here = audit nightmares |
| Tenant isolation | Column + FK + **row-level security** as second wall | Query-discipline only | RLS is a real defense-in-depth layer |
| Flexible attributes | JSONB (indexed, validated) | Native | Get schema-on-read where needed without giving up relations |
| Full-text search | Built-in `tsvector` (English etc.) | Atlas search (hosted) | KB/ticket search in MVP without extra infra |
| Transactions | Strong, ubiquitous | Multi-doc txn slower/awkward | SLA accounting, automation, audit writes need txns |
| Audit patterns | Triggers, append-only tables, hash chains | Possible | Mature patterns |

**Decision: PostgreSQL.** MongoDB's flexibility is not needed; its integrity guarantees are weaker exactly where DeskOS is most sensitive (audit, permissions, SLA).

### Supporting infra
- **Redis** — presence (agents/technicians online), rate limiting, BullMQ job queues (email, automation, session-note generation), hot caches, and the remote broker's room ownership/pub-sub registry. The broker must not advertise production readiness while this adapter is absent.
- **S3-compatible object storage** — attachments, recordings, agent installers/update packages (signed).
- **Messaging** — in-process event bus first (typed domain events, transactional outbox to Postgres); replace with NATS only if cross-service extraction happens. No Kafka/RabbitMQ at this scale.
- **Search** — Postgres FTS first; OpenSearch only if relevance requirements outgrow it.
- **AI** — provider-agnostic gateway module (OpenAI-compatible API + local/self-host option later); no AI call on any path that blocks a critical flow > 2 s (async with streaming UI).

## 3. Domain boundaries (module map)

| Domain | Owns | Emits events (examples) | Extraction readiness |
|---|---|---|---|
| identity | users, credentials, MFA, sessions, API keys | user.created, mfa.enabled | Low coupling; extractable |
| tenancy | orgs, memberships, branding, plans/billing | tenant.provisioned | Low |
| access (rbac) | roles, permissions, grants, policies | permission.changed | Core; keep central |
| directory | end-users/contacts, VIP flags, org structure | — | Low |
| tickets | tickets, threads, SLA engine, queues | ticket.created/updated/resolved, sla.breached | Moderate |
| itsm | incidents/problems/changes/catalogue (P2) | incident.declared | Moderate |
| assets | assets, licences, contracts (P2) | asset.lifecycle | Low |
| devices | agents registry, inventory, telemetry, alerts | device.online/offline, alert.raised | Moderate |
| remote | session lifecycle, consent, policies, recordings index | session.started/ended, session.action | **Already separate plane** |
| automation | rules engine, script registry (P2), executions | automation.ran | Moderate |
| knowledge | articles, versions, visibility | kb.published | Low |
| notifications | fan-out, preferences, channels | — | Low; extractable early |
| integrations | connectors, webhooks out, inbound parsers (email) | — | Moderate |
| reporting | read models, dashboards, exports | — | Read models; extractable (read replicas are a later-stage option, not an initial requirement) |
| ai | gateway, prompts, summaries, similarity | ai.summary.ready | Isolated adapter layer |
| audit | append-only event sink, hash chain, exports | — | Core; keep central |

**Boundary rules:** modules communicate only via typed service interfaces + domain events; cross-module DB joins are forbidden (each module's tables are prefixed and owned); every table carries `tenant_id`.

## 4. Multi-tenancy model

- Single database, shared schema, `tenant_id` on every table + composite indexes leading with it.
- Enforced at three layers: (1) request context middleware resolves tenant from auth + host/route; (2) repository layer injects tenant predicate; (3) Postgres RLS policies as the final wall (app connects with `app.tenant_id` session var). Tests assert cross-tenant access fails at DB level.
- MSP mode (P3): technicians hold memberships in multiple tenants; an active-tenant context switch is explicit, banner-coloured per tenant, and every API call is scoped to exactly one tenant.
- Global (platform) data is minimal: plans, agent release metadata, platform audit.

## 5. Deployment blueprint (cost-efficient, staged)

**Core principle — logical separation first, physical separation later.** Design every service to be horizontally scalable and individually addressable now (`DATABASE_URL`, `REDIS_URL`, configurable TURN/ICE settings, a storage abstraction, a relay registry), but do **not** physically separate services onto dedicated machines until load, reliability, or operational requirements justify it. The goal is the minimum infrastructure that remains professionally production-ready and can scale without architectural rewrites.

Three buckets guide every decision:

1. **Deploy now** — one application VPS plus two redundant relay/TURN nodes; Nginx; Redis and PostgreSQL co-located on the app server; S3-compatible object storage; lightweight Prometheus/Grafana.
2. **Support architecturally now, deploy later** — external load balancer, second API server, dedicated PostgreSQL, dedicated Redis, read replicas, Redis HA (Sentinel/managed). The code and configuration must make these a connection-string/config change, not a rewrite.
3. **Introduce only at significant scale** — Kubernetes, service mesh, Kafka, Redis Cluster, multi-region PostgreSQL, multi-primary databases, GPU servers, dedicated observability clusters, global six-region TURN. These are explicitly out of scope until metrics or customer geography prove they are needed.

### 5.1 Recommended initial production deployment

```
                         INTERNET
                             |
                             v
                    +----------------+
                    |     NGINX      |
                    | TLS / routing  |
                    +-------+--------+
                            |
                +-----------+-----------+
                |                       |
                v                       v
          DeskOS Frontend          Node.js API
                                        |
                         +--------------+-------------+
                         |              |             |
                         v              v             v
                     PostgreSQL      Redis        Workers
                         |
                         +---- S3 object storage (attachments, recordings, updates)

                         REDIS (session registry + pub/sub)
                           |
             +-------------+-------------+
             |                           |
             v                           v
       Relay / TURN 1               Relay / TURN 2
             |                           |
             +-------------+-------------+
                           |
                     WebRTC / ICE
                           |
             +-------------+-------------+
             |                           |
             v                           v
      Technician Browser           Windows Agent

             Preferred path:  Browser <------ P2P ------> Agent
             Fallback path:   Browser <-- TURN Relay --> Agent
```

- **VPS 1 — DeskOS application server:** Nginx (HTTPS termination, reverse proxy, frontend delivery, API routing, WebSocket upgrades, security headers, request-size limits, basic rate limiting), the DeskOS frontend, the Node.js API, authentication, the WebSocket signalling service, background workers, Redis, PostgreSQL, PgBouncer where beneficial, lightweight Prometheus exporters, and application logging agents. Recommended: **8 vCPU / 16 GB RAM minimum, fast NVMe, reliable datacentre networking, automated backups**. 32 GB may be used where pricing is attractive but is not required initially.
- **VPS 2 and VPS 3 — relay/TURN nodes:** coturn + the DeskOS relay daemon + relay health endpoints + metrics exporter + structured logging + OpenTelemetry integration. Two nodes for resilience.
- Redis and PostgreSQL do **not** require dedicated VPS instances at this scale, but they must be deployed so they can move to dedicated infrastructure later by changing `REDIS_URL` / `DATABASE_URL` rather than rewriting application code.
- **No dedicated load balancer initially.** Nginx on the app VPS handles everything while there is a single application server. The system must still allow an external load balancer to be added later when a second API/app server is introduced.

### 5.2 Remote-control network layer

Deploy the remote-control network separately from the application server, and give it redundancy first because active remote sessions are the most sensitive to relay failure. The application/API remains single-node initially.

- **VPS 2 — TURN + relay node 1:** coturn, DeskOS WebSocket/session relay, relay health endpoints, metrics exporter, structured logging, OpenTelemetry.
- **VPS 3 — TURN + relay node 2:** the same stack.

### 5.3 WebRTC peer-to-peer first

This is one of the most important cost-control decisions. Connection order:

```text
Technician  ──WebRTC negotiation──▶  Windows Agent

Preferred:  direct peer-to-peer WebRTC connection
Fallback:   TURN relay
```

TURN must only be used when direct NAT traversal cannot establish a usable connection. The infrastructure must provide STUN and TURN configuration, use ICE negotiation, prefer direct candidate pairs, fall back to TURN where necessary, and **measure how often TURN is required**. Required metrics: direct WebRTC success rate, TURN fallback percentage, ICE negotiation failures, average connection establishment time, TURN bandwidth consumption, TURN allocations, TURN session duration. Optimise continuously to keep TURN usage as low as reasonably possible.

### 5.4 TURN infrastructure

- Use **coturn**. Each TURN node supports UDP, TCP, TLS, and port 443 fallback where appropriate.
- Credentials are **short-lived and generated by the DeskOS backend** — never static credentials embedded in clients. Provide ICE server information dynamically, e.g.:

```json
{
  "iceServers": [
    { "urls": ["stun:turn1.deskos.example"] },
    {
      "urls": [
        "turn:turn1.deskos.example:3478?transport=udp",
        "turn:turn2.deskos.example:3478?transport=udp",
        "turns:turn1.deskos.example:443?transport=tcp"
      ],
      "username": "temporary-credential",
      "credential": "temporary-secret"
    }
  ]
}
```

- Enforce bandwidth controls, allocation limits, abuse prevention, connection limits, and IP reputation/rate limits where practical.
- **Do not put TURN behind a standard HTTP load balancer.** Provide multiple TURN servers through ICE configuration and let WebRTC/ICE choose the usable route. Future regional names (`uk1.turn…`, `eu1.turn…`, `us1.turn…`) are documented but not deployed until customer geography requires them.

### 5.5 Remote media encoding stays on the endpoint

Do not design server-side video encoding. The Windows agent performs Windows Desktop Duplication capture, dirty-region detection, adaptive capture frequency, and hardware H.264 encoding (Intel Quick Sync, NVIDIA NVENC, AMD where available; software fallback where necessary). The relay primarily forwards encrypted WebRTC traffic, so the infrastructure must not require GPU servers.

### 5.6 Adaptive remote desktop quality

Bandwidth adapts to available bandwidth, RTT, jitter, packet loss, screen activity, motion, and text- vs video-heavy content.

| Profile | Resolution | Frame rate | Bitrate |
|---|---|---|---|
| Low bandwidth | 720p | ~10–15 fps | lower |
| Balanced | 1080p | ~20–30 fps | moderate |
| High quality | higher | higher where the network supports it | higher |

Static screens reduce frame rate and send only changed regions where practical; scrolling/animation/motion temporarily increase frame rate and bitrate. Idle screens should cost ~0 in encoded updates.

### 5.7 Object storage

Do not store large user-generated files permanently on the application VPS. Use S3-compatible object storage for ticket attachments, session recordings, exports, screenshots, diagnostic bundles, audit evidence, agent packages, and update binaries/manifests. Implement lifecycle policies; session recording retention is configurable (7/30/90 days or custom enterprise retention), and expired content is deleted automatically.

### 5.8 Monitoring

Keep monitoring lightweight initially: Prometheus, Grafana, OpenTelemetry, structured JSON logs, and Sentry (or equivalent). Do not deploy a large dedicated observability cluster. Track at minimum:

```text
deskos_active_remote_sessions      deskos_websocket_connections
deskos_relay_connections           deskos_relay_rejected_connections
deskos_messages_per_second         deskos_session_creation_rate
webrtc_direct_success_rate         webrtc_turn_fallback_rate
webrtc_ice_failure_rate            webrtc_average_rtt
webrtc_packet_loss                 turn_active_allocations
turn_bandwidth_in                  turn_bandwidth_out
postgres_connection_count          postgres_query_latency
redis_memory_usage                 redis_connected_clients
redis_pubsub_messages              api_request_latency
api_error_rate
```

Create alerts for obvious production problems (relay rejection spikes, TURN fallback rate, ICE failures, DB/Redis saturation, API error rate).

### 5.9 Graceful deployments

For API and relay deployments: stop accepting new work, mark the instance draining, let existing operations complete where possible, remove the instance from service discovery, close connections cleanly, and terminate after a configurable drain timeout. Relay restarts must not destroy session metadata because session ownership lives in Redis; where transport-level reconnection is required, clients attempt automatic recovery.

### 5.10 Security

TLS everywhere; secure HTTP headers; secrets outside source control; short-lived session tokens; device identity and per-device credentials (device certificates where practical); signed agent binaries and update manifests; staged update rollout rings and rollback; session concurrency rules; brute-force and suspicious-session detection; TURN abuse protection; replay protection; one-time/short-lived remote-session authorisation; explicit consent where policy requires it; immutable audit records for sensitive actions. Test specifically for consent bypass, reused session tickets, session hijacking, relay impersonation, ICE credential reuse, TURN open-relay configuration, privilege escalation, cross-tenant access, remote command abuse, and unauthorised file transfer.

### 5.11 Infrastructure stages

- **Stage 1 — development / early production:** VPS 1 (app, API, PostgreSQL, Redis, workers, Nginx) + VPS 2 (relay + coturn). Pilot and very early production where some remote-service downtime is tolerated.
- **Stage 2 — recommended initial commercial production:** VPS 1 (app, API, PostgreSQL, Redis, workers, Nginx) + VPS 2 (relay + coturn) + VPS 3 (relay + coturn). No dedicated load balancer, no second API server, no separate Redis, no separate PostgreSQL.
- **Stage 3 — growing customer base:** move PostgreSQL to a dedicated database VPS when resource contention or reliability requirements justify it (app/API/Redis/workers stay together; two TURN/relay nodes remain). Trigger with metrics, not aesthetics.
- **Stage 4 — increased distributed workload:** move Redis to dedicated infrastructure when several app/relay instances depend on it heavily, memory grows materially, or HA requirements justify isolation. Evaluate Sentinel/managed Redis; do not introduce Redis Cluster unless sharding is actually required.
- **Stage 5 — application high availability:** add a second API/app server and an external load balancer only when application redundancy is required. At this point API servers are stateless, session state lives in Redis/PostgreSQL/object storage, uploads do not depend on local filesystem state, workers use shared queues, and WebSocket coordination uses Redis.
- **Stage 6 — regional scale:** regional TURN/relay pools (e.g. UK/EU/US, two nodes each) behind regional selection, only when customer geography demands it.

### 5.12 Avoid premature complexity

Not part of the initial deployment unless justified by real metrics or customer requirements: Kubernetes, EKS/GKE/AKS, service mesh, Kafka, Redis Cluster, PostgreSQL read replicas, multi-primary databases, multi-region PostgreSQL, dedicated monitoring clusters, GPU servers, multiple API replicas, dedicated Redis VPS, dedicated PostgreSQL VPS, enterprise cloud load balancers, and six-region TURN infrastructure.

### 5.13 Capacity targets

Engineer and load-test the immediate infrastructure for **500 concurrent WebSocket connections and 50 simultaneous remote sessions**, but test with headroom around **1,000–2,000 WebSocket connections and 100–150 simultaneous sessions** before declaring production readiness. Do not provision for 5,000 sessions yet; prove the architecture can scale horizontally when required.

### 5.14 Cost philosophy

Optimise first for direct WebRTC connections, low TURN fallback rates, efficient H.264 encoding, dirty-region capture, adaptive bitrate, low idle frame rates, reasonably powerful shared application infrastructure, cheap high-bandwidth TURN servers, object-storage lifecycle policies, and horizontal scaling only when justified. Favour TURN providers with high or unlimited transfer, strong UK/EU networking, predictable pricing, and sufficient DDoS protection; provider selection stays configurable and decoupled from the application.

**Failure behaviour:** broker down → agents/console retry with backoff and re-register; relay down → renegotiate via the alternate relay (ICE restart); control plane down → in-flight sessions continue (media is peer/relay direct; only signalling and audit buffering are affected, and audit buffers locally then replays).

## 6. Observability & reliability

- OpenTelemetry traces (API ↔ broker ↔ agent spans joined by session id), Prometheus metrics, structured JSON logs (pino), Sentry for web+api, uptime probes on /healthz + synthetic "can we establish a session" probe every minute. The production metric list is in §5.8; keep the observability stack lightweight (single Prometheus/Grafana) rather than a dedicated cluster.
- Session QoS telemetry: connect time, ICE path (p2p/relay), fps, RTT, loss, bitrate → per-session quality report + fleet dashboards; this also feeds the §5.3 TURN-usage metrics.
- **PostgreSQL (co-located on the app server initially):** proper tuning, limited connection pools, PgBouncer where beneficial, indexes, slow-query monitoring, automated backups, WAL archiving, point-in-time recovery where practical, regular restore testing, disk-utilisation alerts, and database health checks. Read replicas are documented as a later-stage capability, not an initial requirement. The first reason to move PostgreSQL to its own server is workload-driven (RAM/CPU/disk-I/O contention with the app, backup impact, HA requirements, or customer count) — not aesthetics.
- **Redis (co-located initially, `REDIS_URL`-addressable):** serves as the distributed coordination layer for the remote-control system — relay registry, session/connection ownership, agent/technician presence, session state, relay-to-relay pub/sub, SDP/ICE/control forwarding, distributed rate limits, connection/session TTLs, and graceful relay reassignment. Nothing that must survive across relay replicas may rely on in-memory state. The relay `/readyz` reports healthy production readiness once Redis-backed distributed ownership is working. Redis Cluster/Sentinel/managed Redis are later-stage options.
- Backups: Postgres PITR; S3 versioning; recordings retention policy per tenant.
- DR: RPO ≤ 15 min (WAL archiving), RTO ≤ 4 h; remote plane redeploys independently. Relay restarts do not destroy session metadata because ownership is in Redis.

## 7. Security architecture summary (detail in 06)

- TLS everywhere; media DTLS-SRTP; WebSocket auth with short-lived session tickets (≤ 5 min, single-use for connect).
- JWT access (15 min) + rotating refresh (httpOnly, device-bound); MFA (TOTP MVP, WebAuthn P2); rate limiting + lockout on auth; suspicious-login detection.
- Secrets: env-injected at deploy, no secrets in repo; integration credentials encrypted at rest (KMS/envelope).
- Agent updates: signed artifacts (minisign/ed25519), staged rollout, version pinning per tenant.
- TURN: short-lived, backend-issued credentials (never static client-embedded secrets); allocation/bandwidth/connection limits; open-relay prevention; abuse and replay protection. See §5.4 and §5.10.

## 8. Deployment Decision Record

**What changed.** The production topology moved from "≥2 API replicas behind a load balancer, managed Postgres with read replicas, managed Redis, and a regional TURN/relay fleet" to a consolidated, staged design: one application VPS (Nginx + frontend + API + workers + Redis + PostgreSQL) plus two redundant relay/TURN nodes.

**Why it was simplified.** The current target is ~500 concurrent WebSocket connections and ~50 simultaneous remote sessions with initial production customers. Splitting every service onto dedicated infrastructure at that load would spend money and operational effort on separation the workload does not yet need. The simplification preserves the scaling path: services remain individually addressable via `DATABASE_URL`, `REDIS_URL`, configurable TURN/ICE settings, a storage abstraction, and a relay registry, so each can move to dedicated infrastructure later without rewriting application code.

**Still consolidated (deploy together initially).** Nginx, frontend, Node.js API, authentication, WebSocket signalling, background workers, Redis, and PostgreSQL on the application VPS; no dedicated load balancer.

**Separated now.** The remote-control network layer — two relay/TURN nodes (coturn + DeskOS relay) — is separated first because active remote sessions are the most sensitive to relay failure and media is the most bandwidth-sensitive component.

**Scaling triggers.** Move PostgreSQL to its own server when app/DB RAM, CPU, or disk-I/O contention appears, backups degrade application performance, or HA/customer requirements justify it. Move Redis to dedicated infrastructure when several app/relay instances depend on it heavily, memory grows materially, or HA requires isolation. Add a second API server and external load balancer only when application redundancy is required. Add regional TURN only when customer geography demands it.

**Migration path.** Stage 1 (pilot, one relay node) → Stage 2 (recommended production, two relay nodes) → Stage 3 (dedicated PostgreSQL) → Stage 4 (dedicated Redis, optionally HA) → Stage 5 (second API/app server + load balancer) → Stage 6 (regional TURN/relay pools). Each transition is a configuration/connection change plus monitoring-justified provisioning, not a rewrite.
