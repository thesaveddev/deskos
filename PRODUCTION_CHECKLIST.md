# ReyDesk — Production Readiness Checklist

## 1. Infrastructure & Deployment

### CI/CD Pipeline
- [ ] CI passes on all branches (typecheck, lint, API tests, web build)
- [ ] E2E test suite passes
- [ ] Helper EXE build pipeline produces signed binaries
- [ ] Deploy pipeline completes with health checks
- [ ] Rollback procedure documented and tested
- [ ] Staging environment mirrors production

### Server & VPS
- [ ] Production server provisioned and secured (SSH keys, firewall, fail2ban)
- [ ] SSL/TLS certificate installed and auto-renewing (Let's Encrypt)
- [ ] Domain DNS configured (api.reydesk.com, app.reydesk.com, relay.reydesk.com)
- [ ] Server monitoring and alerting configured (UptimeRobot, Grafana, or similar)
- [ ] Automated database backups enabled (daily minimum, 30-day retention)
- [ ] Backup restoration tested and verified
- [ ] Log rotation configured
- [ ] Resource monitoring (CPU, RAM, disk, network)

### SSL & Security
- [ ] TLS 1.2+ enforced on all endpoints
- [ ] HSTS headers configured
- [ ] CORS policy restrictive and correct
- [ ] CSP (Content Security Policy) headers configured
- [ ] Helper EXE code-signed (EV certificate for SmartScreen trust)
- [ ] macOS helper signed and notarized (Apple Developer ID)
- [ ] All API endpoints require authentication
- [ ] Rate limiting configured on public endpoints
- [ ] CORS allowlist configured (not wildcard)

---

## 2. S3 / Object Storage

- [ ] `REYDESK_STORAGE_DRIVER=s3` configured in production
- [ ] S3 bucket created with proper ACL (private, not public)
- [ ] CORS policy on bucket allows the app domain
- [ ] `REYDESK_S3_ENDPOINT` configured correctly
- [ ] `REYDESK_S3_REGION` matches bucket region
- [ ] `REYDESK_S3_ACCESS_KEY` and `REYDESK_S3_SECRET_KEY` stored in env (not in code)
- [ ] `REYDESK_S3_PUBLIC_BASE_URL` configured for serving attachments
- [ ] Upload size limits configured (bucket policy + app config)
- [ ] Storage quota per tenant configured in settings
- [ ] Tenant `storage_bytes` tracking verified in production
- [ ] Profile avatar upload tested end-to-end
- [ ] Attachment download from S3 tested
- [ ] Recording upload and playback from S3 tested
- [ ] Chat file transfer upload/download tested
- [ ] Portal attachment download tested

---

## 3. Billing & Payments

- [ ] Stripe account activated and live keys configured
- [ ] Stripe webhook endpoint configured and verified
- [ ] Stripe Checkout session creation tested end-to-end
- [ ] Paystack account activated and live keys configured
- [ ] Paystack webhook endpoint configured and verified
- [ ] Payment region detection working for all supported countries
- [ ] Currency derivation from billing country working
- [ ] Provider price/plan identifiers include currency
- [ ] Offline invoice flow tested
- [ ] Direct card metadata submission rejected (410 status)
- [ ] Payment methods only created through hosted checkout
- [ ] Subscription lifecycle (create, renew, cancel, dunning) tested
- [ ] Plan enforcement (limits) tested for each tier
- [ ] Free tier works without payment requirement
- [ ] Billing analytics display correct data

---

## 4. Remote Desktop & WebRTC

- [ ] WebRTC relay server deployed and accessible
- [ ] TURN server configured (coturn or similar)
- [ ] STUN/TURN configuration tested with restrictive NATs
- [ ] Helper agent Windows build works on Windows 10/11
- [ ] Helper agent macOS build works on macOS 12+
- [ ] Helper EXE code-signed (SmartScreen passes)
- [ ] Consent dialog displays correctly on single-monitor setups
- [ ] Consent dialog displays correctly on multi-monitor setups
- [ ] Screen sharing works for single-monitor devices
- [ ] Screen sharing works for multi-monitor devices
- [ ] Screen selection switcher works (icon-based, non-intrusive)
- [ ] Mouse input is precise (no offset issues)
- [ ] Single mouse cursor (no dual pointer)
- [ ] Scroll gesture transfer works
- [ ] File transfer works both directions
- [ ] File transfer shows accurate size (no "unknown" or "oversized" error)
- [ ] Files save to Downloads\ReyDesk on remote machine
- [ ] Reconnect after browser refresh works
- [ ] Session timeout enforced per settings
- [ ] Session inactivity timeout enforced per settings
- [ ] Flickering console window eliminated
- [ ] Unattended access policy enforced per settings

---

## 5. Chat (Real-Time)

- [ ] WebSocket endpoint (`/api/v1/chat/ws`) accessible behind reverse proxy
- [ ] WebSocket upgrade working through Nginx/Caddy
- [ ] JWT authentication on WebSocket connection working
- [ ] PostgreSQL LISTEN/NOTIFY fan-out working
- [ ] Messages delivered in real-time to all participants
- [ ] Message history loads correctly on initial page load
- [ ] File attachment upload works from chat
- [ ] File attachment display works in chat
- [ ] WebSocket reconnection with exponential backoff works
- [ ] Cross-tab WebSocket sync works
- [ ] Emoji removed from technician chat input
- [ ] File upload icon present in chat input

---

## 6. Customer Portal

- [ ] Portal slug configuration works (changing slug updates access)
- [ ] Old slug no longer accessible after change
- [ ] Portal branding (colors, logo, welcome message) applied
- [ ] Welcome message input width adjusted appropriately
- [ ] "How staff use it" section visually separated with border
- [ ] "Invite staff by email" section visually separated with border
- [ ] Portal toggle (enable/disable) works
- [ ] Public KB toggle works
- [ ] Show device context toggle works
- [ ] Allow requester resolution toggle works
- [ ] Self-service registration toggle works
- [ ] End-user registration flow works
- [ ] End-user sign-in works
- [ ] Magic link sign-in works (when enabled)
- [ ] Ticket creation from portal works
- [ ] Ticket attachments work
- [ ] Knowledge base categories display correctly
- [ ] Knowledge base articles display correctly
- [ ] Portal invite email template renders correctly
- [ ] Portal invite emails are sent successfully
- [ ] Staff can be invited from the staff list

---

## 7. Settings & Administration

### General Settings
- [ ] Organization settings save correctly
- [ ] Region selection persists
- [ ] Region matches billing region by default

### Notification Channels
- [ ] In-app notifications work
- [ ] Email notifications work (configured SMTP)
- [ ] Push notifications work (VAPID keys configured)
- [ ] Webhook notifications work

### Remote Support Settings
- [ ] Maximum session duration enforced
- [ ] Inactivity timeout enforced
- [ ] File transfer size limit enforced
- [ ] Elevated action re-consent works
- [ ] Unattended access policy enforced

### Device Management
- [ ] Enrollment approval works
- [ ] Auto-update policy enforced
- [ ] Minimum agent version enforced
- [ ] Personal device policy works
- [ ] Hardware/software inventory collection works
- [ ] Device retirement after offline period works

### Monitoring
- [ ] Maintenance windows respected
- [ ] Alert routing works per configured channels
- [ ] Alert deduplication works
- [ ] Escalation delays work
- [ ] Notification channels configured

### Data Retention
- [ ] Ticket retention policy enforced
- [ ] Attachment retention policy enforced
- [ ] Chat retention policy enforced
- [ ] Telemetry retention policy enforced
- [ ] Legal hold prevents deletion
- [ ] Purge schedule (daily/weekly) works

---

## 8. User Experience

### Screen Lock
- [ ] Idle timeout updates immediately when changed (no stale timer)
- [ ] Setting 0 correctly disables auto-lock
- [ ] Cross-tab lock sync works
- [ ] Lock screen shows correct user identity
- [ ] Unlock with password works

### Dashboard
- [ ] Dashboard loads with correct stats
- [ ] Dashboard doesn't grow endlessly (fixed height, scrollable)
- [ ] All dashboard widgets load without errors

### Navigation
- [ ] All sidebar links work
- [ ] Back button works
- [ ] Deep links work (direct URL navigation)
- [ ] 404 page shows for unknown routes

### General UX
- [ ] No flickering console windows
- [ ] Loading states show on all async pages
- [ ] Empty states show with helpful messages
- [ ] Error messages are clear and actionable
- [ ] Toast notifications work correctly
- [ ] Responsive design works on tablet and mobile
- [ ] Dark/light theme toggle works

---

## 9. API & Authentication

- [ ] OAuth2 API works for third-party integrations
- [ ] API keys can be created and revoked
- [ ] API rate limiting works
- [ ] API documentation page loads correctly
- [ ] Webhook configuration page works
- [ ] JWT token refresh works without re-login
- [ ] Session timeout works (auto-logout)
- [ ] Password reset flow works end-to-end
- [ ] Invitation flow works end-to-end
- [ ] RBAC (Role-Based Access Control) enforced on all endpoints

---

## 10. Data Integrity & Compliance

- [ ] Database migrations run successfully
- [ ] All tables have proper indexes
- [ ] Foreign key constraints enforced
- [ ] Audit log captures all write operations
- [ ] PHI/sensitive data encrypted at rest (if required)
- [ ] GDPR data export endpoint works
- [ ] GDPR data deletion endpoint works
- [ ] Session recordings stored securely
- [ ] Session recordings access-controlled (only assigned technician)

---

## 11. Performance

- [ ] Initial page load < 3 seconds on 3G
- [ ] Lighthouse performance score > 80
- [ ] Lighthouse accessibility score > 90
- [ ] API response times < 200ms (p95)
- [ ] WebSocket latency < 100ms for chat messages
- [ ] WebRTC connection established < 5 seconds
- [ ] Database query performance monitored
- [ ] CDN configured for static assets
- [ ] Gzip/Brotli compression enabled
- [ ] Image optimization in place

---

## 12. Documentation

- [ ] README updated with production setup instructions
- [ ] Environment variables documented
- [ ] API documentation complete and accurate
- [ ] Admin guide written
- [ ] End-user portal guide written
- [ ] Troubleshooting guide for common issues
- [ ] Changelog maintained

---

## 13. Final Pre-Launch

- [ ] All CI checks pass (typecheck, lint, tests, build)
- [ ] All E2E tests pass
- [ ] Production build tested locally
- [ ] Smoke test on production after deploy
- [ ] SSL certificate valid and auto-renewing
- [ ] DNS propagation verified
- [ ] Monitoring and alerting active
- [ ] Backup schedule verified
- [ ] Support email configured
- [ ] Legal pages (Terms, Privacy) linked and accurate
- [ ] 404 and error pages styled correctly
- [ ] No console errors in production
- [ ] No HTTP 5xx errors in logs
- [ ] Load testing completed (target concurrent users)

---

## Known Issues (Pre-Production)

| Issue | Status | Priority |
|-------|--------|----------|
| Android remote control | Not started | P2 |
| SmartScreen signing for helper.exe | Pending certificate | P1 |
| macOS helper signing/notarization | Pending certificate | P1 |
| Stale bundle error on idle resume | ✅ Fixed (auto-reload) | P1 |
| Screen lock timer not updating | ✅ Fixed | P1 |
| Billing fake card form removed | ✅ Fixed | P1 |
| Chat not delivering messages | ✅ Fixed (WebSocket) | P1 |
| Settings > AD broken page | Needs review | P1 |
| Settings > Public API broken UI | Needs redesign | P2 |
| Portal ID change not propagating | Fixed | P1 |
| Billing region not matching overview | Fixed | P1 |
| Screen selection for multi-monitor | UI added (icon switcher) | P2 |
| Mouse offset on multi-monitor | Needs calibration fix | P1 |
| Dual cursor issue | Needs fix | P1 |
| Helper window too tall | ✅ Fixed (compact) | P2 |
| Helper flickering on screen | Under investigation | P1 |
| End-user file receive from technician | Needs UI implementation | P2 |
