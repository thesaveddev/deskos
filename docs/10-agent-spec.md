# 10 — Endpoint Agent Specification

Lightweight system-service agent for Windows 10+/Server 2016+, macOS 12+, Linux (deb/rpm/tar). Rust, single static binary + OS service wrapper. Budgets: < 120 MB RAM, < 0.5 % CPU idle, < 15 % CPU streaming 1080p30.

## 1. Responsibilities

| Area | Capability |
|---|---|
| Identity | Key generation, enrolment (one-time code / deployment token), device certificate lifecycle (auto-rotation), tenant binding, Windows machine-scope DPAPI protection for the device credential |
| Presence | Persistent WS to broker w/ reconnect+backoff; heartbeat 30 s; state reporting (online/offline/booting/restarting) |
| Inventory | HW (manufacturer, model, serial, CPU, RAM, disks, GPU, NICs, BIOS, TPM, battery), OS (edition/build/patch level), installed apps + versions, drivers, security posture (AV on/off, firewall, encryption/BitLocker/FileVault, Secure Boot) — collected on schedule (daily) + on change |
| Telemetry | Rolling metrics every 60 s including CPU, RAM, disk usage/free space, API round-trip latency, battery level/health when available, uptime, process count, and opt-in service states; the control plane persists telemetry before evaluating device-type-aware rules, schedules, suppressions, escalations, and anomaly baselines. |
| Screen | Capture (Desktop Duplication / ScreenCaptureKit / PipeWire), encode (HW H.264 + VP8 fallback), multi-display enumeration, cursor compositing |
| Input | Apply keyboard/mouse/scroll in normalised coords; CAD sequence injection; respect lock screen policy |
| Terminal | PTY management: `pwsh`/`powershell`, `cmd`, `/bin/sh` per OS; elevated sessions per policy; per-tab audit stream |
| Files | Browse/read/write/rename/delete/mkdir within policy paths; chunked transfer over DataChannel; sensitive-dir deny list enforced agent-side |
| Processes | List (pid, name, cpu, ram, user, start time), terminate, inspect (path, cmdline, hashes) |
| Services | List/start/stop/restart + startup mode (Windows SCM / launchd / systemd) |
| Logs | Tail/query Windows Event Log, `journalctl`/syslog, macOS unified log (filtered, read-only) |
| Scripts | Execute approved script payloads with arg validation; capture output/exit code; privilege level honoured |
| Reboot | Graceful restart, resume-token issuance, early-start service guarantee, safe-mode variants where supported |
| Consent (attended) | Native consent UI + web consent bridge; permission grants enforcement; always-visible session banner with End button |
| Updates | Signed artifact verification, staged apply, health-check, rollback, version reporting |
| Diagnostics | Self-diagnostics bundle (redacted) exportable by org admin |

## 2. Architecture

```
deskos-agent (service, SYSTEM/root)
├── core: config, identity/keys (OS keychain/DPAPI/Keychain protected), scheduler
├── transport: WS client (broker), reconnect, backpressure
├── webrtc: peer connection management, channels (§05-§3)
├── capture: per-OS module (dxgi | screencapturekit | pipewire/x11)
├── encode: hw encoder selection (nvenc/qsv/amf/videotoolbox/vaapi) → vp8 fallback
├── input: per-OS synthesis (SendInput / CGEvents / uinput/xtest)
├── sysinfo: inventory + metrics collectors
├── exec: terminal ptys, scripts, services, processes, files (policy enforcement here)
└── ui: tray icon + consent/banner windows (per-OS native)
```

- **Policy enforcement is local:** the agent refuses actions outside its cached policy snapshot even if the broker were compromised (signed policy bundles, versioned).
- No credentials ever stored; no keylogging hooks; no screen capture outside active, granted sessions; capture pauses on secure desktop where OS isolates it.

## 3. Protocol surface (agent ↔ broker)

WS messages: `hello` (cert auth, versions, capabilities), `heartbeat`, `state`, `session.offer/accept/deny`, `policy.sync`, `inventory.report`, `metrics.report`, `alert.raise`, `update.check/apply/result`, `restart.request/ack`. Media handled peer-to-peer per §05.

## 4. Deployment & lifecycle

- Installers: WiX v4 MSI (GPO/Intune-friendly, signed release artifacts) with customer-assisted, technician-assisted, and protected IT-fleet enrollment paths; PKG, deb/rpm, curl-bootstrap script for Linux.
- Enrolment: one-time codes (15 min TTL, single-use) or signed deployment tokens for fleet rollouts.
- Quarantine mode (org-initiated): stops accepting sessions, keeps presence + telemetry, banner informs user.
- Uninstall: standard OS flows; org policy may require confirmation code; removal event audited.

## 5. Update security

- Release pipeline signs artifacts (ed25519, key in KMS/HSM); signature + hash verification mandatory.
- Rings: canary (1 %) → early (10 %) → fleet, with per-tenant pinning; auto-rollback if crash-loop/health checks fail post-update.
- Downgrade protection (minimum-version floor per tenant).

## 6. Privacy behaviour

- Inventory excludes file contents, browser history, credentials; app list can be restricted by policy.
- Telemetry retention at platform: metrics 30 d rolling (configurable), inventory snapshots versioned.
- On-screen session banner always shows: technician name, organisation, "viewing/controlling", elapsed time, End button.
