# DeskOS — Production Readiness Checklist

This document lists everything needed to take DeskOS from development to production.

---

## 🔴 Must-have (blocks launch)

### Infrastructure
- [ ] **PostgreSQL 15+** — managed (Render, Supabase, Neon) or self-hosted. Run all 40 migrations.
- [ ] **Redis 7+** — for session store, rate limiting, and (optionally) email queue. Render, Upstash, or self-hosted.
- [ ] **Domain + SSL** — point your domain to the deployment. TLS is required for Web Push and cookies.
- [ ] **VAPID keys** — generated and set in env (`DESKOS_VAPID_PUBLIC_KEY`, `DESKOS_VAPID_PRIVATE_KEY`, `DESKOS_VAPID_SUBJECT`). Already done for dev.

### Environment variables (all required)
```
# Database
DATABASE_URL=postgresql://...

# Auth
DESKOS_JWT_SECRET=<64+ char random string>
DESKOS_ACCESS_TOKEN_TTL_SEC=900
DESKOS_REFRESH_TOKEN_TTL_DAYS=30
DESKOS_BCRYPT_ROUNDS=12

# SMTP (for password reset emails, ticket notifications)
DESKOS_SMTP_HOST=smtp.example.com
DESKOS_SMTP_PORT=587
DESKOS_SMTP_USER=...
DESKOS_SMTP_PASS=...
DESKOS_SMTP_FROM=DeskOS <support@yourdomain.com>

# Web Push
DESKOS_VAPID_PUBLIC_KEY=...
DESKOS_VAPID_PRIVATE_KEY=...
DESKOS_VAPID_SUBJECT=mailto:admin@yourdomain.com

# App
DESKOS_PUBLIC_URL=https://yourdomain.com
DESKOS_RELAY_URL=wss://relay.yourdomain.com
```

### Security
- [ ] **Rotate JWT secret** — generate a new 64+ char random string, never use the dev default.
- [ ] **Set bcrypt rounds to 12** — slow enough to resist brute force.
- [ ] **Enable HTTPS** — required for secure cookies, Web Push, and CORS.
- [ ] **Set CORS origins** — restrict to your domain in production.
- [ ] **Rate limiting** — already built into auth routes (30/min login, 10/min signup, 5/min forgot-password). Verify Redis is connected for distributed rate limiting.

### Email
- [ ] **Configure SMTP** — set `DESKOS_SMTP_*` env vars. Password reset and ticket notifications won't send without this.
- [ ] **Test password reset flow** — click "Forgot password?" on login, verify the email arrives.
- [ ] **Set DESKOS_SMTP_FROM** — this appears as the sender on all outbound emails.

### Remote sessions
- [ ] **coturn/TURN server** — required for WebRTC NAT traversal. Without this, remote sessions won't connect across different networks. Options:
  - Self-host coturn on a VPS (~$5/mo)
  - Use a managed TURN service (Twilio Network Traversal, Metered)
- [ ] **Set DESKOS_RELAY_URL** — WebSocket URL for the relay server.
- [ ] **Deploy relay server** — `apps/relay/` is a standalone Node.js service. Deploy alongside or separately from the API.

### Agent / MSI
- [ ] **Code signing certificate** — required for Windows SmartScreen to trust the MSI installer. Without it, users get a scary warning.
  - Buy from SSL.com, Sectigo, or DigiCert (~$200/year)
  - Sign the MSI and the portable helper binary
- [ ] **Build MSI** — `cargo build --release` in `apps/agent/`, then package with WiX.

---

## 🟡 Should-have (needed before marketing)

### Domain & branding
- [ ] **OG image** — create `og-deskos.png` (1200×630) for social sharing previews.
- [ ] **Favicon set** — SVG, 32×32 PNG, 192×192 PNG, 512×512 PNG. Currently using placeholder icons.
- [ ] **Custom domain** — `deskos.com` or your chosen domain. Update `DESKOS_PUBLIC_URL`.
- [ ] **Email templates** — design branded HTML emails for password reset, ticket notifications, etc. Currently plain text.

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
- [ ] **Cookie consent** — DeskOS only uses necessary cookies (session token), so a banner may not be required under GDPR. Verify with legal advice.

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
3. Connect `thesaveddev/deskos`
4. Click Apply — Render reads `render.yaml` and creates PostgreSQL + Redis + the app
5. Set environment variables in the Render dashboard (especially `DESKOS_JWT_SECRET`, SMTP, VAPID keys)
6. After deploy, set `DESKOS_PUBLIC_URL` to your Render URL
7. Visit `/signup` to create your first workspace
8. Set your user as platform admin: `UPDATE users SET is_platform_admin = true WHERE email = 'your@email.com'`
