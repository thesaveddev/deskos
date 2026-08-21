# ReyDesk Windows agent installer

This directory contains the WiX v4 MSI definition for the compiled `reydesk-agent.exe`.

## Build

Install these tools on a Windows build machine:

- Rust/Cargo
- WiX Toolset v7 (`wix` on `PATH`)
- Windows SDK `signtool.exe` when signing releases

Register the WiX UI extension once for the build user:

```powershell
& 'C:\Program Files\WiX Toolset v7.0\bin\wix.exe' -acceptEula wix7 extension add WixToolset.UI.wixext/7.0.0 --global
```

From the repository root:

```powershell
.\packaging\windows\build-msi.ps1 -AcceptEula
```

`-AcceptEula` is intentionally explicit because WiX v7 requires acceptance of its Open Source Maintenance Fee EULA. Review that license with the organization responsible for the build before using the flag.

The unsigned MSI is written to `artifacts\windows\ReyDeskAgent.msi` and includes the standard WiX install-directory wizard. For customer and technician installs, bake the ReyDesk server addresses into the MSI so the endpoint user only needs the one-time enrollment code:

```powershell
.\packaging\windows\build-msi.ps1 -AcceptEula `
  -ApiUrl 'https://reydesk.com/api' `
  -RelayUrl 'wss://support.example.com/relay/ws'
```

If these options are omitted, the development defaults are `http://localhost:4000` and `ws://localhost:4100/ws`. Production builds must be signed with a certificate held outside the repository:

```powershell
.\packaging\windows\build-msi.ps1 -AcceptEula -Sign -Certificate 'C:\secure\codesigning\reydesk.pfx'
```

The script never stores certificate paths or passwords in source control. Configure private-key access through the Windows certificate store or the build runner's protected secret mechanism.

## Customer-assisted installation

This is the normal no-terminal workflow for a user who is physically present at the endpoint:

1. An owner or manager generates a one-time enrollment code in ReyDesk.
2. Give the user the MSI and the code.
3. The user opens the MSI normally and completes the installer wizard.
4. From the Start Menu, open **ReyDesk Agent → Enroll ReyDesk Agent**. The local wizard already knows the ReyDesk server configured in the MSI; enter only the one-time enrollment code.
5. The agent enrolls, stores its credential using machine-scope DPAPI, starts the service, and launches the logged-in-user consent helper. The helper also starts automatically at future Windows logons.
6. When a technician requests an attended session, the user sees the native ReyDesk consent dialog without opening a terminal.

No terminal, Rust, Cargo, Node.js, or administrator command is required from the user. The user only needs permission to install the MSI and approve the enrollment.

## Technician-assisted installation

A technician generates the one-time code, gives the user the MSI and code, and stays on the support call while the user opens **Enroll ReyDesk Agent** from the Start Menu. The technician can verify the endpoint appears under **Devices** and then request an attended remote session. The MSI’s logged-in-user tray helper displays live ReyDesk status and the native consent prompt before screen sharing or input control starts; no terminal is needed.

Customer and technician enrollment uses a 10–12 digit, tenant-bound code that expires after 15 minutes and is consumed after the first successful enrollment. Eight-digit codes remain accepted only for legacy sessions. Read a numeric code to the user by phone when email or file transfer is unavailable; never reuse it across endpoints. Fleet deployment continues to use the separate opaque bootstrap token.

## IT fleet deployment

Fleet tools such as Intune, Group Policy, or an endpoint-management platform can pass the bootstrap properties to the MSI. The end user does not see a terminal or enrollment screen:

```powershell
msiexec /i ReyDeskAgent.msi /qn `
  REYDESK_API_URL="https://api.reydesk.com" `
  REYDESK_RELAY_URL="wss://relay.reydesk.com/ws" `
  REYDESK_ENROLL_TOKEN="<FLEET_BOOTSTRAP_TOKEN>"
```

The MSI stores these temporary bootstrap values under the machine ReyDesk enrollment key. When the service first starts, it enrolls the endpoint, writes the DPAPI-protected config, and deletes the bootstrap values. The fleet system should start the service after installation:

```powershell
Start-Service ReyDeskAgent
```

Fleet bootstrap tokens should be scoped to the intended tenant and deployment ring, rotated regularly, and supplied through the management platform's protected secret mechanism rather than committed to scripts or source control.

## Portable helper (unmanaged / ad-hoc support)

For an unmanaged device that is not enrolled, a technician generates a 10–12 digit support code and connect link from **Remote sessions → Generate support code**. The customer can use the numeric-code option, or the stronger email-link option. With the email-link option, the customer pastes the complete one-time link into the helper; the first helper fingerprint is bound to the claim. The customer then runs the portable helper — the same `reydesk-agent.exe` binary, with no installer, no service, and no terminal:

```powershell
# Numeric-code option
reydesk-agent.exe helper 1234567890

# Stronger emailed-link option
reydesk-agent.exe helper "https://reydesk.com/connect/1234567890?claimToken=deskos_link_..."
```

Double-clicking the downloaded file (or running `reydesk-agent.exe helper` with no code) opens a small native window titled **ReyDesk support** where the customer enters an 8–12 digit code or pastes the complete secure link — no terminal, browser, or arguments needed. Closing that window ends the helper. The helper redeems the single-use claim (`POST /api/connect/<code>/claim`), saves its credentials next to the executable, and runs the same consent + relay + screen/control loop as the installed agent. The customer sees the native ReyDesk consent prompt and can approve or decline; the session then behaves like any attended session.

The API serves the helper on the connect page at `GET /api/connect/<code>/download` (public, single-open-code check). It streams the binary at `REYDESK_HELPER_BINARY`, defaulting to `artifacts\windows\deskos-helper.exe` in the repository.

To let the customer enter only the code, build a per-deployment helper with the server endpoints baked in (otherwise pass `--api-url`/`--relay-url`):

```powershell
$env:REYDESK_API_URL='https://reydesk.com'
$env:REYDESK_RELAY_URL='wss://support.example.com/relay/ws'
cargo build --release --manifest-path apps/agent/Cargo.toml -p deskos-agent
```

The resulting `apps\target\release\reydesk-agent.exe` is the portable helper. Production deployments should serve it from a download endpoint on the `/connect/<code>` page and sign it with the same code-signing certificate as the MSI.

## Endpoint installation details

The MSI installs the agent under `Program Files`, registers the `ReyDeskAgent` service as **manual start**, and adds a per-user Startup shortcut for the logged-in-user tray helper. Manual start is intentional for customer and technician installs: enrollment must create the DPAPI-protected configuration before the service starts. Successful GUI enrollment starts both the service and the tray helper immediately. The tray helper uses a machine-wide single-instance guard, so enrollment plus Windows Startup cannot create duplicate consent prompts. Hovering the tray icon shows whether ReyDesk is online or offline and whether consent is pending. During a control session, the requested input permission arms automatically when the reliable control channel opens; keyboard, mouse, drag/resize, and wheel input use a separate unordered/unreliable input channel so stale pointer motion cannot queue behind older events. The endpoint cursor is shown over the video, and pointer coordinates are mapped to the combined captured displays using DPI-aware Windows coordinates. Clipboard synchronization is separately permission-gated and runs through the reliable control channel with a 1 MB text limit. The technician can also request an audited elevated PowerShell terminal; terminal access requires both `terminal` and `elevation` permissions and runs over its own ordered reliable DataChannel. Commands execute as soon as they are submitted, and output streams back over the same channel. File transfer is separately permission-gated, uses an ordered `files` channel, is confined to the managed `C:\Users\Public` root by default, denies traversal and sensitive directory names, and limits each transfer to 16 MB; the technician console shows the endpoint's managed root so uploads always land visibly in the current folder. Process and service management is separately permission-gated and elevated; the agent blocks protected process IDs and core services while auditing list and action requests.

When a session requests elevated capabilities (terminal or process/service management), the endpoint user is prompted twice: once for the base session and once with an explicit elevated-access warning. Declining elevation continues the session with screen sharing and input only, and the reduction is recorded in the session timeline as `session.elevation_denied`.

The technician console includes an audited session chat (persisted and broker-relayed), a participant list with technician invite (owner/technician/observer roles), and ownership transfer. Technician chat is delivered to the endpoint agent over the relay; the service writes it into a shared per-session mailbox under `%ProgramData%\ReyDesk\chat`, and the logged-in-user tray helper opens a lightweight browser chat page the first time a new message arrives. The endpoint user can read the technician's messages and reply there; replies are persisted through the API, audited as `session.chat.sent`, and relayed back to the technician console in real time. The mailbox is cleared when the session ends. The **Full screen** action expands the existing session view without opening a second connection. The technician shell keeps a persistent session-dock entry and browser-owned session runtime, so the operator can visit another ReyDesk screen and return without tearing down the WebRTC peer or input channels. If Windows shows no wizard, run it with an explicit verbose log:

```powershell
msiexec /i .\ReyDeskAgent.msi /l*v .\ReyDeskAgent-install.log
```

On Windows, the config is protected with machine-scope DPAPI and contains a short envelope rather than the plaintext device token. The service runs as LocalSystem, so machine scope is required for the service to decrypt the enrollment created by an administrator. Local administrators can still access machine-scope secrets; production deployments should restrict local administrator access according to endpoint policy.

## Update signing

Agent update artifacts are verified with SHA-256 plus an optional ed25519 signature over `<version>:<sha256>`. Bake the public key into a release build so endpoints refuse unsigned or tampered artifacts:

```powershell
$env:REYDESK_UPDATE_PUBLIC_KEY='<base64 32-byte ed25519 public key>'
cargo build --release --manifest-path apps/agent/Cargo.toml -p deskos-agent
```

The API serves the manifest through `GET /api/v1/agent/update` (`REYDESK_UPDATE_VERSION/URL/SHA256/SIGNATURE/ROLLOUT_PERCENT`). Verify a downloaded artifact manually with:

```powershell
.\reydesk-agent.exe verify-update .\deskos-agent-0.1.1.exe --version 0.1.1 --sha256 <hex> --signature <base64>
```

When no `REYDESK_UPDATE_PUBLIC_KEY` is baked in, the SHA-256 check is still enforced and signed artifacts are rejected. The Authenticode/MSI signature (`signtool`) is separate and remains the Windows SmartScreen trust path.

## Upgrade and removal

Upgrading the MSI preserves the `ProgramData\ReyDesk` configuration. Stop the service before replacing a binary if the MSI does not do so automatically:

```powershell
Stop-Service ReyDeskAgent -ErrorAction SilentlyContinue
```

Uninstalling the MSI removes the service and executable but does not intentionally delete the device configuration directory, allowing an administrator to inspect or securely remove it according to retention policy. To remove only the service registration from a manually installed binary:

```powershell
& 'C:\Program Files\ReyDesk Agent\reydesk-agent.exe' uninstall-service
```
