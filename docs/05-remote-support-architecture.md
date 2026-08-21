# 05 — Remote Support Architecture

The differentiator of ReyDesk. Design goals: sub-100 ms perceived input latency on good links, connect < 5 s, NAT-proof, consent- and policy-enforced, fully auditable, browser technician console (no client install), reboot-survivable.

## 1. Topology

```
┌─────────────┐        WSS (signalling + control channels)        ┌──────────────┐
│ Agent (Rust)│◀─────────────────────────────────────────────────▶│ Session      │
│ Win/macOS/  │                                                   │ Broker       │
│ Linux svc   │      SRTP media: P2P if possible, else relay      │ (auth, match,│
└──────▲──────┘◀────────────────────────────┐                     │ signal, audit│
       │                                    │                     └──────┬───────┘
  screen capture/encode                     │                            │ WSS
  input decode/apply                        ▼                            ▼
                                   ┌──────────────┐             ┌──────────────┐
                                   │ TURN/Relay   │◀───────────▶│ Browser      │
                                   │ (redundant)  │   media     │ console      │
                                   └──────────────┘             │ (WebRTC)     │
                                                                └──────────────┘
```

### Transport decisions

| Concern | Decision | Rationale |
|---|---|---|
| Signalling & control | WebSocket over TLS to broker | Bidirectional, firewall-friendly (443), auth-per-message possible |
| Desktop video | **WebRTC (SRTP)**, H.264 primary (hardware encode/decode everywhere), VP8 fallback | Browser-native decode (no WASM latency tax), DTLS-SRTP encryption, congestion control (GCC), NACK/PLI built-in |
| Input events | Dedicated WebRTC DataChannel (unordered, unreliable mode) | Same ICE path as video → consistent latency; loss of an old mouse move is harmless. The browser creates `input` with `ordered: false` and `maxRetransmits: 0`; the reliable `control` channel carries session handshake and cursor telemetry. |
| Terminal / files / clipboard / commands | DataChannel in reliable-ordered mode (SCTP) | Must not drop; can share the peer connection |
| Why not pure-WebSocket video | No congestion control, no HW decode path, CPU-ruinous at scale | Rejected |
| Why not RDP-gateway (Guacamole-style) | Requires RDP enabled/licensing, weak consent control, server-side transcode CPU cost, poor macOS/Linux parity | Rejected as primary; keep as future option for Windows-server niches |
| NAT traversal | ICE: host → srflx (STUN) → relay (TURN over 443/TLS + UDP) | Corporate networks: 443-TLS TURN is the reliable fallback |
| Codec | H.264 (Constrained Baseline, HW via NVENC/QSV/VideoToolbox/VAAPI where present); VP8 software fallback; AV1 considered later for low-bandwidth | Best compatibility/latency today |

**Peer-to-peer first.** Direct P2P WebRTC is the preferred transport; TURN is used only when direct NAT traversal fails. STUN/TURN configuration and short-lived credentials are delivered dynamically by the backend (see `04-system-architecture.md` §5.3/§5.4), ICE prefers direct candidate pairs, and the relay fleet measures the direct-success and TURN-fallback rates so TURN usage can be minimised.

### Capture & encode (agent side)
- **Windows:** Desktop Duplication API (per-output DXGI), dirty-region tracking; cursor composited; hardware encode via Media Foundation/encoder APIs.
- **macOS:** ScreenCaptureKit (per-display streams, cursor metadata, window filtering consent surface).
- **Linux:** PipeWire (Wayland) portal; X11 fallback via XDamage/Shm.
- Frame pipeline: capture → dirty rects → tile-diff encode decision → HW encoder → packetise. Idle screens cost ~0 (no frame churn).

## 2. Identity & session establishment

### Agent identity
- Install → agent generates keypair → enrolment code (one-time, tenant-scoped) or tenant deployment token → broker issues **device certificate** (short-lived cert + auto-rotation). All subsequent auth is certificate/mTLS-backed websocket + signed heartbeats. No shared secrets stored on device beyond protected key material.

### Session types
1. **Attended (consent):** technician requests session with a target *contact* (or generates a session code/link). End user opens `/connect/:code` (or agent consent UI): sees technician name/photo, organisation, requested permissions → Accept. Consent grant is per-permission, time-boxed, revocable at any moment (agent-side kill-switch + banner "ReyDesk is sharing your screen — End now").
2. **Unattended (policy):** technician selects device. Broker evaluates policy gate (§4). User of the device gets an on-screen notification banner during connection ("Marcus from Acme IT is connecting — reason: ticket #4521").
3. **Inspection (view-only telemetry):** lightweight channel for processes/services/health without screen sharing — used by device-page tabs; still policy-checked and audited.

### Connect flow (happy path, attended)
```
technician clicks Remote Control
  → API: POST /sessions {deviceId|code, ticketId?, permissions[], reason}
  → policy engine evaluates (RBAC, device group, MFA state, consent requirement)
  → session record created (state REQUESTED) → broker notified
  → agent shows consent (or already-consented unattended path)
  → user accepts → broker issues single-use join tickets to both sides (≤5 min)
  → console + agent open WS to broker with tickets → broker rooms them
  → SDP/ICE exchange via broker → DTLS-SRTP established
  → state CONNECTED; recording starts if policy dictates
```

## 3. In-session channels (one PeerConnection)

| Channel | Mode | Content |
|---|---|---|
| `video` | SRTP tracks (per selected display) | Encoded desktop, cursor metadata |
| `input` | DC unordered/unreliable | Keyboard/mouse/scroll/touch events (normalised coordinate space). Stale motion may be dropped to preserve interactive latency; button and key transitions are validated by the agent. |
| `control` | DC reliable | Session handshake, endpoint presence, cursor telemetry, clipboard (policy-gated), display switch, quality requests, pause/resume, and CAD injection |
| `terminal` | DC reliable (per tab) | PTY streams (agent spawns shell/PowerShell; elevation per policy) |
| `files` | DC reliable | Chunked transfer with manifests; browses via `control` RPC |
| `sysdata` | DC reliable | Processes/services/sysinfo/log tails on demand |
| `presence` | WS via broker | Chat, notes, participant join/leave, handover |

## 4. Zero-trust policy evaluation (every connection)

Broker + policy engine evaluate, per attempt: technician identity & MFA level · tenant membership · role permissions (`remote.control` etc.) · device-group scope · device trust (agent cert valid, tenant-owned) · session-type rules (attended/unattended) · org policy (recording mandatory? manager approval for sensitive groups?) · reason-required flag · concurrent-session limits · suspicious-activity heuristics (geo jump, repeated failures). Failure returns an actionable denial (shown to technician; audited).

**Being logged into the helpdesk never implies remote access.** Default-deny; grants are explicit, reviewable, expirable.

## 5. Reboot & auto-reconnect (state machine)

```
RUNNING ──Restart&Reconnect──▶ RESTART_REQUESTED ──agent signals shutdown──▶ DEVICE_OFFLINE
   ▲                                                                              │
   │                                                            agent boots, cert auth
SESSION_RESTORED ◀── RECONNECTING ◀── AGENT_ONLINE ◀── DEVICE_BOOTING ◀──────────┘
```

- Agent service is early-start (systemd/launchd/Windows service auto-start). On boot it re-registers with prior **session resume token** (encrypted, ≤ 30 min TTL, single-use).
- Console holds the session (dock shows live state transitions); broker re-rooms automatically if policy allows unattended re-entry; if org policy requires consent after reboot, console waits with clear state.
- Safe-mode reboot supported where the agent service survives safe boot (Windows minimal w/ networking).

## 6. Privilege elevation

- Agent runs as a **system service** (root/SYSTEM) but executes technician commands inside scoped execution contexts. Elevation is *per action*, granted by policy, not a blanket admin shell:
  - Terminal sessions have an `elevated` flag; opening elevated requires `remote.elevated_terminal` permission + (configurable) MFA step-up + reason.
  - Script executions declare required privilege level; policy maps level → allowed device groups.
  - Windows UAC prompts remain visible and interactable through the remote session (secure desktop handling documented per OS).
  - **No credential vault in MVP** (Phase 3: JIT vault with checkout/check-in, no plaintext exposure to technician).
- Every elevated action is double-audited (agent-side + broker-side records reconciled).

## 7. Recording

- Policy modes: `off | optional | mandatory | security-sensitive-only | device-group:<id>`; per-tenant defaults + overrides.
- MVP: **metadata recording always** (input/command/file/service timeline) + optional video capture by forwarding the endpoint-encoded stream when enabled — recording never re-encodes on the server (no GPU/transcode infrastructure required); user notified on-screen when recording is active.
- Recordings: encrypted at rest, retention policy per tenant, access restricted by role (`session.view_recording`), watermark with technician identity, hash-pinned for tamper evidence.

## 8. Collaboration

- Participants table per session (owner, invited, observers). Owner can invite (notification with join ticket), transfer ownership, or release to another technician/team; observers get video-only.
- Every action carries actor identity; handover preserves full audit continuity.

## 9. QoS & adaptation

- Bandwidth modes: Auto / High / Balanced / Low — one-click in toolbar. Adaptive encoding adjusts resolution, frame rate, and bitrate to available bandwidth, RTT, jitter, packet loss, screen activity, and content type:
  - **Low bandwidth:** 720p, ~10–15 fps, lower bitrate (drops further on constrained links).
  - **Balanced:** 1080p, ~20–30 fps, moderate bitrate.
  - **High quality:** higher bitrate and refresh where the network supports it.
- Static screens significantly reduce frame rate and send only changed regions where practical; scrolling/animation/motion temporarily raise frame rate and bitrate. Idle screens cost ~0 encoded updates.
- GCC congestion control + dynamic resolution/framerate; quality stats streamed to console HUD (fps/RTT/loss/path: p2p|relay).
- Session quality report persisted at end (used in reports domain).

## 10. Agent lifecycle & updates

- Heartbeat every 30 s (WS ping) + telemetry deltas; offline detection at 90 s.
- Updates: release artifacts signed (ed25519); agent verifies before applying; staged rollout rings per tenant; rollback on health-check failure; update events audited and visible in device page.
- Uninstall: policy can require admin confirmation; leaves audit trail.

## 11. Performance budgets

| Metric | Target (p75) |
|---|---|
| Click-to-consent shown (attended) | < 2 s |
| Connect (consented → first frame) | < 5 s |
| Input-to-pixel latency (good link) | < 100 ms |
| Idle CPU (agent) | < 0.5 % |
| Active CPU (agent, 1080p30) | < 15 % typical HW encode |
| RAM (agent) | < 120 MB |
| Relay hop added latency | < 40 ms intra-region |
