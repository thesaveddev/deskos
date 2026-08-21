# ReyDesk staging browser journeys

The default Playwright suite uses deterministic API boundary fixtures for fast local coverage. The staging specs in this directory intentionally use the deployed web/API stack and are skipped unless explicitly enabled.

## Required staging setup

Use a disposable staging organization and a dedicated test user. Do not use a production account, production mailbox, or a production endpoint.

For the authentication and MFA journeys:

- `DESKOS_E2E_EMAIL` — dedicated staging user email
- `DESKOS_E2E_PASSWORD` — dedicated staging user password
- `DESKOS_E2E_SETUP_MFA=true` — run the one-time MFA enrollment journey for a user without MFA
- `DESKOS_E2E_TOTP_SECRET` — existing TOTP secret when the account already has MFA, or after the setup journey for later runs

For real email delivery verification:

- `DESKOS_E2E_DELIVERY_ADDRESS` — an existing staging account whose mailbox can be inspected
- `DESKOS_E2E_INBOX_API_URL` — a Mailpit-compatible inbox API base URL
- `DESKOS_E2E_INBOX_TOKEN` — optional inbox API bearer token

The email test submits a real password-reset request and waits for a matching message. It does not print reset links or mailbox contents.

For the remote-support journey:

- `DESKOS_E2E_DEVICE_ID` — a dedicated enrolled staging endpoint
- `DESKOS_E2E_AGENT_TOKEN` — the endpoint's device bearer token

Keep the native ReyDesk agent/helper running on that endpoint for the complete run. It must be online, able to capture a screen, and configured to accept the requested staging session permissions. The test creates a real attended session, sends consent through the authenticated agent control plane, waits for WebRTC media, exercises browser input control, uploads a harmless text file, runs `echo DESKOS_PLAYWRIGHT_REMOTE_OK` in the explicitly elevated terminal, and ends the session.

## Run

PowerShell:

```powershell
$env:PLAYWRIGHT_TARGET = "staging"
$env:PLAYWRIGHT_BASE_URL = "https://staging.example.com"
$env:PLAYWRIGHT_STAGING_MUTATIONS = "true"
$env:DESKOS_E2E_EMAIL = "playwright@staging.example.com"
$env:DESKOS_E2E_PASSWORD = "use-a-dedicated-secret"
$env:DESKOS_E2E_DEVICE_ID = "00000000-0000-0000-0000-000000000000"
$env:DESKOS_E2E_AGENT_TOKEN = "deskos_device_token"
$env:DESKOS_E2E_DELIVERY_ADDRESS = "playwright-mailbox@staging.example.com"
$env:DESKOS_E2E_INBOX_API_URL = "https://mailpit.staging.example.com"
$env:DESKOS_E2E_INBOX_TOKEN = "optional-inbox-token"
$env:DESKOS_E2E_TOTP_SECRET = "existing-account-secret"
npm run test:e2e -- --project=desktop e2e/staging-auth.spec.ts e2e/staging-remote-support.spec.ts
```

`PLAYWRIGHT_STAGING_MUTATIONS=true` is required for MFA enrollment, password-reset delivery, session creation, consent, file transfer, terminal execution, and termination. Without it, those mutation journeys are skipped rather than run accidentally.

The staging specs run only in the desktop project. Deterministic browser-boundary specs can continue to run in the same Playwright configuration without staging credentials.
