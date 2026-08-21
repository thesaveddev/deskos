# ReyDesk rebrand migration

## Changed

The public product brand is now **ReyDesk**, with the tagline **Support Simplified.** and canonical marketing domain `reydesk.com`. The frontend metadata, navigation, portal, login/support copy, transactional email copy, API/relay service labels, remote-support UI, Windows installer labels, documentation, deployment templates, and public sitemap/robots references are being migrated to the new brand.

## Domains

- `https://reydesk.com` — canonical public site
- `https://www.reydesk.com` — canonical marketing host used by SEO metadata
- `https://api.reydesk.com` — reserved/configurable API host for production
- `wss://relay.reydesk.com` — reserved/configurable relay host for production
- `https://updates.reydesk.com` — reserved/configurable update host; use only when the update service is deployed

The API and relay URLs remain environment-configurable; the reserved hosts above are not assumed to exist until DNS and services are provisioned.

## Compatibility

- Existing `DESKOS_*` environment variables, API headers, storage paths, cookies, Redis prefixes, protocol event names, and Windows service identifiers are retained as compatibility identifiers where changing them would disrupt running deployments.
- New public configuration should use `REYDESK_*` aliases where supported; the API accepts the legacy names as fallbacks during rollout.
- Existing device IDs, certificates, agent registrations, MSI UpgradeCode, database volumes, and audit history are preserved. No customer data or historical audit text is rewritten.
- The legacy browser icon remains as an unreferenced compatibility asset while new pages use the ReyDesk icon.

## Legacy references

Remaining `DeskOS`, `deskos`, and `DESKOS` references must be reviewed after the migration search. Expected retained classes are:

- `DESKOS_*` environment names and deployment variables, accepted as backward-compatible aliases.
- `deskos` database role/database and Docker volume names, retained to avoid creating a new empty database or breaking local production-like environments.
- `DeskOSAgent` Windows service name, registry paths, and `ProgramData\\DeskOS`, retained so existing installations can upgrade without re-registration. A future installer migration can add ReyDesk display names while preserving the underlying service identity.
- `X-DeskOS-Tenant`, `x-deskos-*`, webhook headers, WebSocket/Redis identifiers, token prefixes, and persisted technical formats, retained until all clients have migrated.
- Historical documentation/audit/test fixtures only where they explicitly describe legacy compatibility.

## Manual actions required

1. Create DNS records and issue TLS certificates for the production hosts actually used.
2. Set `REYDESK_PUBLIC_URL`, `REYDESK_WEB_ORIGINS`, `REYDESK_RELAY_URL`, and the other new aliases in the deployment secret manager; retain the old variables until every service is upgraded.
3. Update Render/VPS/Nginx/CORS, OAuth, SMTP, webhook, TURN, and push-notification provider settings with the final deployed hosts.
4. Verify `support@reydesk.com`, `sales@reydesk.com`, `privacy@reydesk.com`, and `legal@reydesk.com` exist and are authorized sender/recipient addresses before enabling them.
5. Sign the ReyDesk Windows MSI/helper with the production Authenticode certificate and publish the new download/update URLs.
6. Rename the GitHub repository and external OAuth applications only after confirming redirect and CI secret changes.
7. Apply the compatibility installer migration for existing `DeskOSAgent` services before changing any underlying service or data-directory identifiers.

## Verification

Run the web/API/relay builds and relevant auth, remote-support, email, and agent tests. Perform a case-insensitive repository search and classify every remaining legacy match; no unexplained user-visible DeskOS reference is acceptable.
