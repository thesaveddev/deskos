-- DeskOS schema: provider-neutral CTI/PBX integration boundary.
-- Provider credentials are encrypted; inbound webhook tokens are hashed and
-- shown only once when an integration is created.

CREATE TABLE telephony_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  provider text NOT NULL DEFAULT 'generic',
  webhook_token_hash text NOT NULL UNIQUE,
  click_to_call_url text,
  provider_secret_enc text,
  auto_match boolean NOT NULL DEFAULT true,
  auto_create_ticket boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);
CREATE INDEX telephony_integrations_tenant_idx ON telephony_integrations (tenant_id, enabled);

ALTER TABLE telephony_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_integrations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_telephony_integrations ON telephony_integrations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
