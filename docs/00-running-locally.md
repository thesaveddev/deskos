# Running DeskOS locally

## Prerequisites

- Node.js ≥ 20
- No Docker and no system PostgreSQL required — dev uses an **embedded PostgreSQL** (real PG18 binaries, managed by `pg-embedded`) started automatically by the `dev:db` script.

## One-time setup

```powershell
cd C:\Users\Opeyemi Olorunfemi\apps\deskos
npm install
```

> First run downloads ~160 MB of PostgreSQL binaries (cached under `%USERPROFILE%\.theseus`).

## Start everything concurrently

```powershell
npm run dev
```

This launches four processes with prefixed logs via `concurrently`:

| Process | What | Where |
|---|---|---|
| `db` | Embedded PostgreSQL + auto-migrations | `postgresql://deskos:deskos_dev_only@localhost:5432/deskos` (data persisted in `apps/api/.devdb/`) |
| `api` | Fastify API (tsx watch, auto-migrates with retry) | http://localhost:4000 — health: `/healthz`, routes under `/api/v1` |
| `relay` | Session broker placeholder | http://localhost:4100 — health: `/healthz` |
| `web` | Vite React console (proxies `/api` → :4000) | http://localhost:5180 |

Open **http://localhost:5180**. Stop with `Ctrl+C` (one keystroke kills all four).

### Useful variants

```powershell
npm run dev:db      # database only
npm run dev:api     # API only (waits/retries for DB)
npm run dev:web     # frontend only
```

The API retries migrations for ~30 s while the database boots, so startup order doesn't matter.

## Tests

```powershell
cd apps\api
npm test
```

Tests boot their own **isolated embedded PostgreSQL** (random port, fresh cluster, least-privilege non-superuser role) — no shared state with your dev database, no setup needed. Current suite: 19 tests covering auth/MFA/refresh-reuse, RBAC, RLS tenant isolation (API + raw-SQL level), and rate limiting.

```powershell
npm run typecheck   # api (also: npm run typecheck --workspaces at repo root)
npm run lint        # eslint (flat config, typescript-eslint)
```

## Environment

Defaults work with zero configuration. To customise, copy `apps/api/.env.example` to `apps/api/.env`:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATABASE_URL` | `postgresql://deskos:deskos_dev_only@localhost:5432/deskos` | Matches `dev:db` |
| `DESKOS_DB_POOL_MAX` | `10` | Maximum API PostgreSQL connections per process; size against the database connection budget when horizontally scaling |
| `DESKOS_JWT_SECRET` | *(unset)* | Unset = ephemeral secret, tokens die on restart. **Required in production.** |
| `DESKOS_EMAIL_KEY` | *(unset)* | Used to encrypt per-tenant IMAP channel passwords at rest (AES-256-GCM). Unset = ephemeral key in dev. **Required in production.** |
| `DESKOS_IMAP_HOST` / `USER` / `PASS` | *(unset)* | **Legacy single-mailbox mode.** Set all three to enable email-to-ticket fallback when no channels are configured. See below. |
| `DESKOS_IMAP_PORT` | `993` | SSL port (set `DESKOS_IMAP_TLS=false` for STARTTLS) |
| `DESKOS_IMAP_POLL_INTERVAL_SEC` | `60` | How often the inbox is polled |
| `RELAY_MAX_CONNECTIONS` | `10000` | Per-relay-process WebSocket ceiling; production must use the distributed broker registry |
| `RELAY_MAX_PEERS_PER_SESSION` | `4` | Per-session peer ceiling |
| `RELAY_MAX_MESSAGES_PER_SECOND` | `1000` | Per-connection signalling/control message ceiling |
| `RELAY_MAX_MESSAGE_BYTES` | `65536` | Maximum broker message size |

| `REDIS_URL` | *(unset)* | Enables Redis-backed relay room membership, ticket consumption, and cross-instance pub/sub; required for production relay readiness |
| `RELAY_REDIS_PREFIX` | `deskos:relay` | Redis key/channel namespace for this deployment |

For a local distributed-relay test, start Redis with `docker compose up -d redis`, or run the installed Redis service directly with `redis-server`. Then run the relay with `REDIS_URL=redis://localhost:6379`. The adapter explicitly uses RESP2 for compatibility with the Redis 5 service on this development machine; production co-locates Redis on the application server initially and may move to a supported managed Redis later (see `04-system-architecture.md` §5).

The API and relay expose `/readyz` in addition to `/healthz`. Relay `/readyz` deliberately returns `503` in production until Redis is configured and live failover tests pass; `/metrics` exposes Prometheus-compatible relay counters.

## Email-to-ticket

Two ways to get inbound email → tickets:

### 1. Per-tenant email channels (recommended for multi-tenant)

Each tenant configures **their own** mailbox (IMAP host/user/pass, encrypted at rest with `DESKOS_EMAIL_KEY`). The poller runs every 60s, connects to every enabled channel, and routes each message into the tenant that owns the channel — create a new ticket, or append a reply to the matching ticket when the subject carries a number like `[#39]` / `#39` / leading `42` (resolved tickets auto-reopen). Duplicate `Message-ID`s are dropped via the tenant-scoped `processed_emails` table.

Admin endpoints (require `settings.manage`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/email/status` | Worker status (last poll, counts, errors) |
| `POST` | `/api/v1/email/poll` | Trigger a poll of **all** channels now |
| `GET` | `/api/v1/email/channels` | List this tenant's channels (password masked) |
| `POST` | `/api/v1/email/channels` | Create a channel |
| `PATCH` | `/api/v1/email/channels/:id` | Update a channel (omit `imapPass` to keep it) |
| `DELETE` | `/api/v1/email/channels/:id` | Delete a channel |
| `POST` | `/api/v1/email/channels/:id/test` | Test IMAP connectivity + unseen count |
| `POST` | `/api/v1/email/channels/:id/poll` | Poll a single channel now |
| `POST` | `/api/v1/email/channels/test` | Test credentials **before saving** (no channel id) |

Note: the API trims whitespace from channel host/user/address inputs. A stray leading space in a pasted username causes IMAP auth to fail — the worker reports it as `Command failed` from the server's `NO` response. Re-saving the channel (or the pre-save test) trims it away.

### 2. Legacy single-mailbox mode (dev only)

When **no channels are configured** and `DESKOS_IMAP_*` are set, the poller falls back to the env-configured mailbox and routes every message to the **oldest tenant**. Configuring even one channel switches the poller to channel mode.

```powershell
# apps/api/.env
DESKOS_EMAIL_KEY=<openssl rand -hex 32 output>
DESKOS_IMAP_HOST=safari.mxrouting.net
DESKOS_IMAP_PORT=993
DESKOS_IMAP_USER=support@example.com
DESKOS_IMAP_PASS=change-me
DESKOS_IMAP_TLS=true
```

> Note: channel IMAP passwords are encrypted at rest (`DESKOS_EMAIL_KEY`) and never returned by the API — only a masked placeholder is. Credentials never live in the repo.
| `DESKOS_DEV_DB_PORT` | `5432` | For `dev:db` if 5432 is taken — also update `DATABASE_URL` |
| `RELAY_MAX_CONNECTIONS` | `10000` | Per-relay-process WebSocket ceiling; production must use the distributed broker registry |
| `RELAY_MAX_PEERS_PER_SESSION` | `4` | Per-session peer ceiling (technician, agent, and limited observers) |
| `RELAY_MAX_MESSAGES_PER_SECOND` | `1000` | Per-connection signalling/control message ceiling |
| `RELAY_MAX_MESSAGE_BYTES` | `65536` | Maximum broker message size |

The API and relay expose `/readyz` in addition to `/healthz`. Relay `/readyz` deliberately returns `503` in production until the Redis-backed room registry is enabled; `/metrics` exposes Prometheus-compatible relay counters.

## Troubleshooting

- **Port 5432 busy** — you have another Postgres running. Stop it, or set `DESKOS_DEV_DB_PORT=5433` and matching `DATABASE_URL`.
- **`EBUSY ... pg-embedded...node` during npm install** — a previous test/dev run was hard-killed and a zombie Node process is holding the native binding. Check `Get-Process node` for orphaned `vitest`/`tsx` processes and kill them (a reboot always clears it). Known quirk: `pg-embedded` rewrites its installed version with a `+pg18.0` suffix which makes npm re-extract on every install; if it recurs, set the `version` field in `node_modules\pg-embedded\package.json` and `node_modules\@pg-ts\pg-embedded-win32-x64-msvc\package.json` back to `0.2.3`.
- **Orphan postgres after a killed test run** — find it with `Get-Process postgres` and stop with `& "$env:USERPROFILE\.theseus\postgresql\18.0.0\bin\pg_ctl.exe" stop --pgdata <data-dir-from-postmaster.pid> --mode fast`.
