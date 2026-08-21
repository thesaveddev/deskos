# ReyDesk — Production Readiness Checklist

This document lists everything needed to take ReyDesk from development to production.

---

## 🔴 Must-have (blocks launch)

### Infrastructure
- [ ] **PostgreSQL 15+** — managed (Render, Supabase, Neon) or self-hosted. Run all 40 migrations.
- [ ] **Redis 7+** — for session store, rate limiting, and (optionally) email queue. Render, Upstash, or self-hosted.
- [ ] **Domain + SSL** — point your domain to the deployment. TLS is required for Web Push and cookies.
- [ ] **VAPID keys** — generated and set in env (`REYDESK_VAPID_PUBLIC_KEY`, `REYDESK_VAPID_PRIVATE_KEY`, `REYDESK_VAPID_SUBJECT`). Already done for dev.

### Environment variables (all required)
```
# Database
DATABASE_URL=postgresql://...

# Auth
REYDESK_JWT_SECRET=<64+ char random string>
REYDESK_ACCESS_TOKEN_TTL_SEC=900
REYDESK_REFRESH_TOKEN_TTL_DAYS=30
REYDESK_BCRYPT_ROUNDS=12

# SMTP (all outbound email: auth, invitations, tickets, notifications, support)
REYDESK_SMTP_HOST=smtp.example.com
REYDESK_SMTP_PORT=587                 # 587 = STARTTLS; 465 = implicit TLS
REYDESK_SMTP_USER=...
REYDESK_SMTP_PASS=...
REYDESK_SMTP_FROM=ReyDesk <support@yourdomain.com>
REYDESK_SMTP_TLS=true
REYDESK_SMTP_JSON=false

# Web Push
REYDESK_VAPID_PUBLIC_KEY=...
REYDESK_VAPID_PRIVATE_KEY=...
REYDESK_VAPID_SUBJECT=mailto:admin@yourdomain.com

# App
REYDESK_PUBLIC_URL=https://yourdomain.com
REYDESK_WEB_ORIGINS=https://yourdomain.com
REYDESK_RELAY_URL=wss://relay.yourdomain.com

# Relay service (configure on the relay deployment)
REYDESK_RELAY_SECRET=<32+ char random string shared with the API>
RELAY_ALLOWED_ORIGINS=https://yourdomain.com
```

### Security
- [ ] **Rotate JWT secret** — generate a new 64+ char random string, never use the dev default.
- [ ] **Set bcrypt rounds to 12** — slow enough to resist brute force.
- [ ] **Enable HTTPS** — required for secure cookies, Web Push, and CORS.
- [ ] **Set CORS origins** — set `REYDESK_WEB_ORIGINS` to a comma-separated allowlist; never use wildcard origins with credentials.
- [ ] **Set relay browser origins** — set `RELAY_ALLOWED_ORIGINS` on every relay instance; native agents without an `Origin` header remain supported, while browser peers must match the allowlist.
- [ ] **Rate limiting** — already built into auth routes (30/min login, 10/min signup, 5/min forgot-password). Verify Redis is connected for distributed rate limiting.

### Email
- [ ] **Configure SMTP** — set `REYDESK_SMTP_HOST`, `PORT`, `USER`, `PASS`, `FROM`, and `TLS` in the deployment secret manager. Never commit credentials.
- [ ] **Use the correct TLS mode** — port 587 uses STARTTLS; port 465 uses implicit TLS. ReyDesk now enforces TLS 1.2+ and STARTTLS when configured.
- [ ] **Check outbound status** — authenticated administrators can inspect `GET /api/v1/email/outbound/status`; it reports transport, sender, authentication, last failure, queue depth, and dead letters without exposing secrets.
- [ ] **Run the SMTP probe** — `POST /api/v1/email/outbound/test` verifies the connection before testing a real recipient.
- [ ] **Inspect failed jobs** — use the job id returned by remote-support email requests with `GET /api/v1/email/outbound/jobs/:jobId`; retry a dead letter with `POST /api/v1/email/outbound/jobs/:jobId/retry`.
- [ ] **Test every path** — password reset, email verification, magic link, staff invitation, public ticket reply/resolve, notification preferences, inbound call alerts, and remote-support email links use the same queue and branded HTML/text templates.
- [ ] **Set `REYDESK_SMTP_FROM`** — this appears as the sender on all outbound emails and should use a verified domain address.

### Remote sessions
- [ ] **Use strong unmanaged-session handoff** — new support codes are 10–12 digits; configure technicians to use the emailed one-time link mode when possible. Link claims are hashed, single-use, and bind the first helper fingerprint. Treat the numeric code as a fallback for phone-assisted support.
- [ ] **coturn/TURN server** — required for WebRTC NAT traversal. Without this, remote sessions won't connect across different networks. Options:
  - Self-host coturn on a VPS (~$5/mo)
  - Use a managed TURN service (Twilio Network Traversal, Metered)
- [ ] **Set REYDESK_RELAY_URL** — use a `wss://` URL for the public relay endpoint.
- [ ] **Deploy relay server** — `apps/relay/` is a standalone Node.js service. Deploy alongside or separately from the API.
- [ ] **Require Redis and origin allowlisting on the relay** — production relay startup fails without `REYDESK_RELAY_SECRET` and `RELAY_ALLOWED_ORIGINS`.

### Agent / MSI
- [ ] **Code signing certificate** — required for Windows SmartScreen to trust the MSI installer. Without it, users get a scary warning.
  - Buy from SSL.com, Sectigo, or DigiCert (~$200/year)
  - Sign the MSI and the portable helper binary
- [ ] **Build MSI** — `cargo build --release` in `apps/agent/`, then package with WiX.

### Go-live release gates
These items are launch blockers, not post-launch enhancements:

- [ ] **Agent update apply and rollback** — implement Windows in-place apply, restart health checks, automatic rollback, and audited failure recovery.
- [ ] **Signed Windows releases** — sign MSI, portable helper, update manifests, and published hashes; validate SmartScreen and upgrade paths.
- [ ] **Production coturn and NAT/media lab** — deploy TURN with UDP and TCP/TLS 443 fallback; test direct WebRTC, TURN fallback, packet loss, ICE failures, multi-monitor, and reconnect.
- [ ] **Object storage** — move recordings, large attachments, exports, diagnostic bundles, and release artifacts to S3-compatible storage with signed URLs, lifecycle retention, quotas, and restore testing.
- [ ] **Durable webhook delivery** — add a persistent retry queue, exponential backoff, dead-letter handling, idempotency keys, replay protection, and outbound destination controls.
- [ ] **Repeatable load and browser tests** — the local Playwright auth/lock journey is now deterministic and runs on desktop plus mobile Chromium; still run the k6/Playwright staging suite for 500 WebSocket connections, 50 remote sessions, and headroom scenarios before launch.
- [ ] **Multi-node relay/TURN** — deploy two relay/TURN nodes with Redis-backed ownership, failover, graceful draining, monitoring, and synthetic attended-session probes.
- [ ] **Native mobile packaging** — validate Android/iOS builds, configure FCM/APNs, register native tokens, sign releases, and test real devices.
- [ ] **Approved-script execution** — complete agent-side policy validation, execution, output capture, cancellation, timeout, cleanup, and audit correlation.
- [ ] **Release hygiene** — exclude generated logs, local recordings, secrets, and unrelated worktree artifacts from the release commit.

---

## 🟡 Should-have (needed before marketing)

### Domain & branding
- [ ] **OG image** — create `og-reydesk.svg` (1200×630) for social sharing previews.
- [ ] **Favicon set** — SVG, 32×32 PNG, 192×192 PNG, 512×512 PNG. Currently using placeholder icons.
- [ ] **Custom domain** — `reydesk.com` or your chosen domain. Update `REYDESK_PUBLIC_URL`.
- [x] **Email templates** — branded responsive HTML templates with plain-text fallbacks cover password reset, ticket notifications, magic links, verification, and MFA-related authentication mail. Review tenant branding and copy before launch.

### Monitoring & observability
- [ ] **Error tracking** — integrate Sentry or similar. The API logs to stdout but has no error aggregation.
- [ ] **Uptime monitoring** — set up checks on `/healthz` and `/readyz` endpoints.
- [ ] **Metrics** — the `/metrics` endpoint exposes basic counters. Consider Prometheus + Grafana.
- [ ] **Log aggregation** — structured JSON logs are emitted. Ship them to a centralised service (Datadog, Logtail, etc.).

### Backup & recovery
- [ ] **Database backups** — enable daily automated backups on your PostgreSQL provider.
- [ ] **Test restore** — verify you can restore from backup.
- [ ] **Disaster recovery plan** — document the steps to rebuild from scratch.

### Legal & compliance
- [ ] **Privacy Policy** — already written at `/privacy`. Review with a lawyer.
- [ ] **Terms of Service** — already written at `/terms`. Review with a lawyer.
- [ ] **DPA (Data Processing Agreement)** — needed for EU customers if you process their data.
- [ ] **Cookie consent** — ReyDesk only uses necessary cookies (session token), so a banner may not be required under GDPR. Verify with legal advice.

### CI/CD
- [ ] **GitHub Actions CI** — already configured (typecheck, build, test, lint). Verify it runs on push.
- [ ] **Render deployment** — `render.yaml` is ready. Connect the repo and deploy.
- [ ] **Staging environment** — deploy to a staging URL before production. Run the full test suite there.

---

## 🟢 Nice-to-have (post-launch improvements)

### Performance
- [ ] **CDN** — serve static assets (CSS, JS, fonts, images) from a CDN (Cloudflare, Fastly).
- [ ] **Database connection pooling** — PgBouncer or built-in pooler if using serverless Postgres.
- [ ] **Load testing** — k6 script exists at `tests/load/load-test.js`. Run it against staging.

### Scalability
- [ ] **Horizontal API scaling** — the API is stateless (sessions in Redis). Add more instances behind a load balancer.
- [ ] **Relay clustering** — for multi-region relay, deploy relay nodes in US, EU, APAC.
- [ ] **Database read replicas** — for heavy read workloads (reports, compliance queries).

### Features still TODO
- [ ] **Email verification on signup** — routes exist, UI not yet wired.
- [ ] **Change password in settings** — API route exists, no UI page yet.
- [ ] **Push notification settings UI** — the API works, but there's no page to enable/disable push per notification kind.
- [ ] **Agent self-update** — download/verify works, in-place apply needs Windows-specific code.
- [ ] **Scheduled inventory collection** — agent pushes on demand; no scheduled trigger yet.
- [ ] **DEX history charts** — score is computed; no per-device historical view.
- [ ] **Patch ring auto-advance** — rings advance manually; no time-based auto-advance.

### Mobile
- [ ] **Android APK signing** — generate a keystore and sign the release build.
- [ ] **iOS provisioning** — Apple Developer account, provisioning profile, App Store submission.
- [ ] **Push notifications on mobile** — FCM setup for Android, APNs for iOS.

---

## Quick deployment (Render Blueprint)

1. Push to GitHub (already done)
2. Go to https://dashboard.render.com → New Blueprint
3. Connect `thesaveddev/reydesk`
4. Click Apply — Render reads `render.yaml` and creates PostgreSQL + Redis + the app
5. Set environment variables in the Render dashboard (especially `REYDESK_JWT_SECRET`, SMTP, VAPID keys)
6. After deploy, set `REYDESK_PUBLIC_URL` to your Render URL
7. Visit `/signup` to create your first workspace
8. Set your user as platform admin: `UPDATE users SET is_platform_admin = true WHERE email = 'your@email.com'`
