-- DeskOS schema: bound lifetime for unmanaged support device credentials.
-- Managed device tokens remain non-expiring by default; ad-hoc helper tokens
-- are explicitly marked and expire with the support-code/session window.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS adhoc boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS agent_token_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS devices_adhoc_token_expiry_idx
  ON devices (tenant_id, agent_token_expires_at)
  WHERE adhoc = true;
