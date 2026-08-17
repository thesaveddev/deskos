# DeskOS preview runbook

## Reproduce the worktree artifacts

1. From the main checkout, copy `apps/api/.env` into this worktree at `apps/api/.env`; copy the file itself, never symlink it, and do not record its secret values here. In this thread the main checkout and worktree are the same path, so the file is already present.
2. From the repository root, run `npm install` using the committed `package-lock.json`.
3. The development database creates its persistent embedded-PostgreSQL data under `apps/api/.devdb/` and applies migrations automatically when the stack starts. Do not copy database files from another checkout. The relay runs in local in-memory mode by default; for distributed relay testing, copy the Redis service configuration from the main checkout and run Redis at `redis://localhost:6379` before setting `REDIS_URL`. The local Redis 5 service was live-verified with the relay adapter using RESP2; production should use a supported managed Redis version.

## Run the server

From the repository root, run:

```powershell
npm run dev
```

This starts the embedded database, API, relay, and Vite web app concurrently:

- Web preview: `http://localhost:5180` (Vite listens on `0.0.0.0` for LAN access)
- API health: `http://localhost:4000/healthz` (API listens on `0.0.0.0` by default)
- Relay health: `http://localhost:4100/healthz`

If a default port is already occupied by another process, stop that process only when it belongs to this DeskOS stack; otherwise adapt the relevant `PORT`, `DESKOS_DEV_DB_PORT`, or Vite server/proxy configuration and keep the API proxy target aligned. If the DeskOS database, relay, and web processes are already healthy, do not launch a second full stack: reuse them and start only the API with `npm run dev:api`; launching `npm run dev` again can fail its embedded-PostgreSQL startup and make Vite move to port 5181.

In this thread, the host environment injects `PORT=0`. That makes `npm run dev` choose random ports for the API and relay while Vite still serves on 5180, so the web proxy cannot reach the API at its configured port. For a stable LAN setup, run the components with explicit ports from separate PowerShell windows:

```powershell
$env:HOST="0.0.0.0"; npm run dev:db
$env:HOST="0.0.0.0"; $env:PORT="4000"; npm run dev:api
$env:HOST="0.0.0.0"; $env:RELAY_PORT="4100"; npm run dev:relay
npm run dev:web
```

The web proxy reaches the API at `localhost:4000` from the Vite process, while other devices open the web app through this PC's LAN address.

## LAN access and device enrollment

1. Find this PC's private IPv4 address in PowerShell:

   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } | Select-Object IPAddress,InterfaceAlias
   ```

2. From another device on the same private network, open `http://<PC_LAN_IP>:5180`.
3. If the page cannot connect, allow inbound TCP ports 5180, 4000, and 4100 on the Windows **Private** firewall profile. Run this in an elevated PowerShell only if needed:

   ```powershell
   New-NetFirewallRule -DisplayName "DeskOS development" -Direction Inbound -Protocol TCP -LocalPort 5180,4000,4100 -Action Allow -Profile Private
   ```

4. In DeskOS, sign in as an owner or manager, open **Devices**, choose **Deploy agent**, and generate an eight-digit enrollment code. Read the code to the endpoint user by phone if needed; it expires after 15 minutes and is consumed once. The separate opaque fleet token is used only for protected IT deployment.
5. For the normal customer-assisted or technician-assisted path, build or distribute an MSI whose server addresses are already configured. The user opens **DeskOS Agent → Enroll DeskOS Agent** from the Start Menu and enters only the one-time code; no API URL, relay URL, terminal, Rust, or Cargo is needed on the endpoint. After enrollment, the MSI starts the service and a logged-in-user tray helper; the helper also starts at future Windows logons and shows live online/offline status in its tooltip. The tray helper has a machine-wide single-instance guard so enrollment and Startup cannot produce duplicate consent prompts.
6. The Rust agent CLI supports enrollment, credential persistence, heartbeat, inventory, telemetry, session polling, and explicit consent/state commands. Rust is needed on a development/build machine, not on every deployed endpoint. Install it on this PC with:

   ```powershell
   winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements
   ```

   Verify the agent with:

   ```powershell
   cargo check --manifest-path apps/Cargo.toml
   cargo test --manifest-path apps/Cargo.toml
   ```

   For development, run the agent directly from this repository:

   ```powershell
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- enroll --api-url http://192.168.10.106:4000 --relay-url ws://192.168.10.106:4100/ws --enrol-token '<TOKEN_FROM_DESKOS>' --config .\deskos-agent.json
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- run --config .\deskos-agent.json
   ```

   For an attended development endpoint, opt into the consent prompt explicitly:

   ```powershell
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- run --config .\deskos-agent.json --interactive-consent
   ```

   Windows displays a native Yes/No consent dialog containing the session reason and requested permissions.   The Windows service never enables interactive consent; it defaults to deny-by-omission and only resumes sessions that already have the explicit `reboot_reconnect` permission. An endpoint administrator can invoke the local kill switch at any time:

   ```powershell
   .\deskos-agent.exe end --config C:\ProgramData\DeskOS\deskos-agent.json --session-id <SESSION_ID>
   ```

   Ending a session from the technician console also sends an authenticated relay `session_end` signal, so a connected agent stops its reconnect loop immediately.


   For deployment, build `cargo build --release --manifest-path apps/Cargo.toml -p deskos-agent` on a build machine and distribute the resulting endpoint binary/installer. Endpoints only need the compiled `deskos-agent` binary and its OS permissions; they do not need Rust, Cargo, Node.js, PostgreSQL, or the DeskOS source tree. The diagnostic capture command can verify interactive desktop capture locally:

   ```powershell
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- capture --output .\deskos-screen.png
   ```

   This writes a local screenshot. The same capture and H.264 encoding pipeline is now wired into consented WebRTC sessions; if a session cannot publish video, use this command to separate desktop-capture permissions from transport/codec issues. The config file contains the device credential and must stay local and protected. For a quick development smoke test before building the Rust CLI, enroll a test endpoint manually from PowerShell. Replace the URL with this PC's LAN IP and use the generated token:

   ```powershell
   $body = @{
     token = '<TOKEN_FROM_DESKOS>'
     name = $env:COMPUTERNAME
     hostname = $env:COMPUTERNAME
     os = 'windows'
     osVersion = (Get-CimInstance Win32_OperatingSystem).Version
     arch = $env:PROCESSOR_ARCHITECTURE
     agentVersion = 'dev-manual'
   } | ConvertTo-Json

   Invoke-RestMethod -Uri 'http://<PC_LAN_IP>:4000/api/v1/agent/enrol' -Method Post -ContentType 'application/json' -Body $body
   ```

   Store the returned `deviceToken` securely. It is the credential used by the agent for heartbeat, inventory, metrics, and remote-session consent calls. When consent is granted, the CLI now joins the configured relay WebSocket and waits for technician signaling. Input control is opt-in: the technician must have `remote.control`, request `control_input`, and arm the console control button; the Windows agent validates the normalized payload before calling `SendInput`. Non-Windows agents reject native input until their OS backend is implemented. The CLI's explicit consent commands are:

   ```powershell
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- consent --config .\deskos-agent.json --session-id <SESSION_ID> --granted true
   cargo run --manifest-path apps/Cargo.toml -p deskos-agent -- state --config .\deskos-agent.json --session-id <SESSION_ID> --state active
   ```

## Remote-control audit behavior

The attended consent dialog runs off the heartbeat polling task, so leaving it open does not make the endpoint appear offline. The logged-in-user tray helper shows `DeskOS: online`, `DeskOS: offline`, or `DeskOS: consent pending` in its tooltip. During an active control session, requested input permission arms automatically when the secure control channel opens; the endpoint cursor is drawn into the captured desktop and sent over the authenticated data channel, while drag, resize, right-click, and wheel input use DPI-aware coordinates across the combined displays. Pointer motion is throttled and stale video frames are dropped to keep control responsive. The console's **Full screen** action expands the existing connection without opening a duplicate peer. The agent also records relay, WebRTC, and screen-publisher diagnostics in the session timeline, including `session.screen.frame_encoded` or `session.screen.capture_error`. The agent reports redacted audit events to `POST /api/v1/agent/sessions/<SESSION_ID>/events` for validated button, wheel, and keyboard actions. High-frequency pointer motion is intentionally not persisted because it would add latency and database load. The session timeline records `session.input.accepted` or `session.input.rejected` with only the action name and a bounded reason; pointer coordinates, key values, and raw control payloads are never stored. The API accepts accepted events only for sessions granted `control_input` and in a connecting, active, or reconnecting state. Native backend failures are recorded as rejected events, while the Windows `SendInput` kill-switch and explicit console arming remain required before input is applied.

## Device removal

A device manager can open an enrolled device and choose **Remove device**. DeskOS confirms the destructive action, deletes the tenant-scoped device record, cascades its remote sessions and telemetry, records the audit event, and immediately revokes the device bearer token. The endpoint must be enrolled again to return to the Devices list.

## Remote-session reconnect

The Rust agent keeps a consented relay session alive after a transient WebSocket failure. It waits with bounded exponential backoff, calls `POST /api/v1/agent/sessions/<SESSION_ID>/reconnect` for a fresh single-use agent ticket, rejoins the relay, and reports the session active again. The browser console reacts to the agent's new relay join and renegotiates WebRTC. Ending the session from DeskOS prevents further reconnect tickets; press Ctrl+C on the agent to stop its reconnect loop.

## Windows service and reboot recovery

Build the release binary on a build machine, copy the binary and protected agent config to the endpoint, then install the native Windows service from an **elevated PowerShell**:

```powershell
cargo build --release --manifest-path apps/Cargo.toml -p deskos-agent
.\apps\target\release\deskos-agent.exe install-service --config C:\ProgramData\DeskOS\deskos-agent.json
```

The installer registers `DeskOSAgent` with automatic startup, configures Windows service recovery, and starts it. To remove it later:

```powershell
.\deskos-agent.exe uninstall-service
```

The service runs the same agent loop without requiring Rust, Cargo, Node.js, or an interactive terminal. On startup it discovers active sessions that include the explicit `reboot_reconnect` permission, obtains a fresh single-use broker ticket, and resumes relay/WebRTC negotiation. Sessions without that permission remain stopped until a new consent flow is completed. On Windows, the agent config is stored as a machine-scope DPAPI envelope; legacy plaintext JSON configs are migrated the next time the agent loads them. Machine scope is required because the service runs as LocalSystem.

## Windows MSI packaging

The reproducible WiX v4 source and build script are under `packaging/windows`. Build an unsigned development MSI with:

```powershell
.\packaging\windows\build-msi.ps1
```

For a production artifact, run the same script with a protected code-signing certificate and Windows SDK `signtool.exe`:

```powershell
.\packaging\windows\build-msi.ps1 -Sign -Certificate 'C:\secure\codesigning\deskos.pfx'
```

The MSI installs the agent with a standard install-directory wizard, registers `DeskOSAgent` in manual-start mode, and adds a logged-in-user tray helper to Windows Startup. Customer and technician enrollment uses an eight-digit code that expires after 15 minutes and is consumed once; fleet deployment retains the separate opaque bootstrap token. Build customer/technician MSI packages with `-ApiUrl` and `-RelayUrl` so the Start Menu **Enroll DeskOS Agent** shortcut opens a local browser wizard that asks for only the one-time enrollment code; no terminal or endpoint URL entry is required. Successful enrollment starts both the service and the consent helper, which displays attended-session prompts in the logged-in Windows desktop. Fleet tools can pass `DESKOS_API_URL`, `DESKOS_RELAY_URL`, and `DESKOS_ENROLL_TOKEN` MSI properties; the service consumes those bootstrap values, writes the DPAPI-protected config, and deletes the temporary values. Enroll first so the config exists, then run `Start-Service DeskOSAgent`. If double-clicking produces no visible UI, run `msiexec /i DeskOSAgent.msi /l*v DeskOSAgent-install.log` and inspect the verbose log.

## Portable helper (unmanaged / ad-hoc support)

For an unmanaged device, a technician generates a support code and connect link from **Remote sessions → Generate support code**. The customer opens `/connect/<code>`, downloads the helper, and opens it — no installation or terminal. Build a helper with this PC's LAN address baked in so the customer only enters the code:

```powershell
$env:DESKOS_API_URL="http://192.168.10.106:4000"
$env:DESKOS_RELAY_URL="ws://192.168.10.106:4100/ws"
cargo build --release --manifest-path apps/agent/Cargo.toml -p deskos-agent
Copy-Item apps\target\release\deskos-agent.exe artifacts\windows\deskos-helper.exe
```

The API serves that binary at `GET /api/connect/<code>/download`; it reads `DESKOS_HELPER_BINARY` and defaults to `artifacts\windows\deskos-helper.exe`. Set `DESKOS_HELPER_BINARY` to an absolute path in production (and rebuild the helper with the deployment's public endpoints). The helper also accepts the code directly — `deskos-agent.exe helper 12345678` — and, when double-clicked with no arguments, opens a small native **DeskOS support** window for the code (no terminal or browser).

## WebRTC ICE / TURN (media path)

The browser and agent now fetch their ICE servers from the API at session join (`GET /api/v1/sessions/:id/ice` for technicians, `GET /api/v1/agent/sessions/:id/ice` for the agent). STUN-only is the default, which is enough for same-LAN sessions; TURN is required for the technician and endpoint to connect across NAT/firewalls and is configured with:

```
DESKOS_ICE_STUN_URLS=stun:stun.l.google.com:19302
DESKOS_ICE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:443
DESKOS_ICE_TURN_SECRET=<coturn static-auth-secret>
DESKOS_ICE_TURN_REALM=deskos
DESKOS_ICE_TURN_TTL_SEC=3600
DESKOS_ICE_TURN_USERNAME=deskos
```

The API mints short-lived credentials in coturn's REST-API format (`<unix-expiry>:<user>` + base64 HMAC-SHA1 of that username with `DESKOS_ICE_TURN_SECRET`) and returns them to both peers; no TURN credential is stored anywhere. For a local coturn, `docker compose up turn` starts one matching `--static-auth-secret=deskos-turn-dev-only` (set `DESKOS_ICE_TURN_SECRET` to the same value and `DESKOS_ICE_TURN_URLS` to `turn:127.0.0.1:3478`). If the ICE lookup fails, the agent falls back to host-candidate-only media and the browser to public STUN.
