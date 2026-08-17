# 06 — Threat Model

Scope: DeskOS control plane, remote plane, endpoint agent, browser console, tenant data. Method: asset inventory → STRIDE per component → mitigations → residual risks. Zero-trust principle: no implicit trust from network position, login state, or prior sessions.

## 1. Crown jewels

1. **Live remote control of customer endpoints** (highest blast radius).
2. Tenant data (tickets, identity data, files, recordings).
3. Audit trail integrity (compliance value).
4. Agent software supply chain (fleet-wide code execution potential).
5. Platform credentials/secrets (signing keys, DB, KMS).

## 2. STRIDE analysis

| # | Component | Threat | Class | Mitigation | Residual |
|---|---|---|---|---|---|
| T1 | Auth | Credential stuffing / brute force | Spoofing | Rate limits, lockout w/ backoff, breach-password check, MFA enforced for technicians, WebAuthn option | Targeted phishing — mitigated by training + session step-ups |
| T2 | Auth tokens | Token theft (XSS) | Spoofing | Short-lived access JWT (15 min), httpOnly SameSite=Strict refresh, CSP strict + no inline scripts, device binding, revocation list | — |
| T3 | Session join | Forged join to live session | Spoofing | Single-use join tickets signed by broker, bound to device+technician+session id, ≤5 min TTL | — |
| T4 | Agent | Rogue agent impersonating device | Spoofing | Device certificate issuance only via enrolment codes; cert pinning; tenant binding; heartbeat signature checks | Enrolment code leak — codes one-time, expiring, revocable |
| T5 | Broker | Compromised broker injects/observes | Tampering/InfoDisc | Media is end-to-end DTLS-SRTP (broker never holds keys); broker compromise ≠ media compromise; broker hardened minimal image, no tenant data at rest | Signalling metadata exposure — minimised, audited access |
| T6 | Relay | Relay operator snooping | InfoDisc | SRTP encrypted; relay sees ciphertext; relay builds are reproducible; access logged | Timing/traffic analysis — accepted, low value |
| T7 | Tenant isolation | Cross-tenant read/write | Elevation | tenant_id + RLS (DB-level), middleware context, integration tests that assert denial; object-storage paths tenant-scoped; signed URLs tenant-validated | — |
| T8 | RBAC | Privilege escalation via API | Elevation | Permission checks at service layer (not UI only); deny-by-default; policy tests per endpoint; audit of permission changes | — |
| T9 | Remote session | Technician accessing device beyond scope | Elevation | §05-§4 zero-trust gate per connection; device-group scopes; reason capture; anomaly detection (off-hours, unusual groups) | Insider threat — mitigated by mandatory recording policies + dual-control options for sensitive groups |
| T10 | Consent | Bypassing user consent | Elevation | **Hard rule:** attended sessions cannot transition to control without grant; consent state is agent-enforced (not broker-trusted); unattended requires explicit policy enablement per device group + visible user banner | Enterprise policy may legitimately waive consent (unattended) — that is a policy decision, surfaced + audited, never hidden |
| T11 | Audit | Log tampering | Tampering | Append-only tables, hash-chained (each entry signs previous), no UPDATE/DELETE grants, exports verifiable; recordings hash-pinned | DBA-level attack — mitigated by managed DB access controls + chain verification detecting gaps |
| T12 | Files | Malicious upload/download | Tampering | AV scan hook at intake, size/type limits, signed URLs w/ TTL, download paths restricted by policy (deny-list sensitive dirs configurable) | Social engineering via files — user training |
| T13 | Scripts | Unapproved code execution | Elevation | Script library only (no free-form exec unless org explicitly enables with elevated permission); versioned + approved artifacts; per-device-group allow lists; full command audit | — |
| T14 | Agent updates | Supply-chain compromise | Tampering | ed25519-signed artifacts, signature verification pre-install, staged rings, rollback, reproducible builds, signing key in HSM/KMS | Key compromise — HSM + rotation ceremony |
| T15 | Email-to-ticket | Injection/spam storms | DoS/Tampering | Sender verification (SPF/DKIM checks), HTML sanitisation (no scripts), rate limits, loop detection | — |
| T16 | API | DoS / abuse | DoS | Per-tenant + per-IP rate limits, payload caps, slowloris guards, WS connection quotas, backpressure | Large-scale DDoS — edge/CDN protection |
| T17 | Recordings | Unauthorised viewing | InfoDisc | Role-gated, expiring signed URLs, watermarking, access audited | — |
| T18 | Clipboard | Data exfiltration via clipboard | InfoDisc | Clipboard channel disabled by default per org policy; audited when enabled | — |
| T19 | Dependencies | Vulnerable npm/cargo deps | Tampering | Lockfiles, Dependabot/Renovate, CI audit gates, minimal deps | — |
| T20 | Multi-monitor/CAD | Secure desktop interception | InfoDisc | Windows secure desktop (UAC) rendered normally via session; no credential scraping APIs ever used; documented stance | — |

## 3. Zero-trust connection evaluation (normative)

Every remote connection request MUST pass, in order, with fail-closed semantics:

1. Technician authenticated, session valid, MFA level ≥ org requirement for remote access.
2. Role holds permission (`remote.attended` / `remote.unattended` / `remote.elevated_*`).
3. Device exists, agent certificate valid, device bound to same tenant (or MSP membership active).
4. Device within technician's device-group scope.
5. Session type permitted for device group (some groups: attended-only).
6. Org policies satisfied: recording consent shown where mandatory; manager approval obtained where required; connection reason captured where required.
7. Anomaly checks pass (velocity, geo, repeated failures).

Denials are actionable (tell the technician *what is missing*) and audited.

## 4. Safety constraints (non-negotiable, from product mandate §79)

DeskOS MUST NOT ship functionality that: bypasses user consent outside explicit, audited enterprise policy; hides an active session from the endpoint user; evades or disables endpoint security products; harvests credentials (no keylogging, no password-field capture); bypasses MFA; reaches devices outside authorised tenant ownership; installs silent persistence beyond the declared, visible agent; conceals technician activity from the audit trail. Violations of these constraints are treated as release-blocking defects.

## 5. Privacy & compliance notes

- GDPR/UK GDPR: end-user personal data minimised to what support needs; consent screens double as transparency notices; right-to-erasure implemented as pseudonymisation pipeline with retention overrides; recordings have retention + erasure workflows; DPIA template provided to tenants.
- Data residency: region per tenant at provisioning (control + remote plane co-located in region); no cross-region media.
- ISO 27001 / SOC 2 mapping: access control, audit logging, change management, incident response, vendor management controls documented per domain (compliance matrix deferred to Phase 3 deliverable).

## 6. Incident response hooks

- Kill switches: per-device agent quarantine (stops sessions, keeps heartbeat), per-technician session revocation, tenant-wide remote-access suspension (one-click by org owner).
- Suspicious-login + anomalous-session alerts route to Security role with evidence bundle (audit extract).
