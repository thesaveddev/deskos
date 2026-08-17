-- DeskOS schema: per-tenant inbound email channels (tenant-scoped, RLS)

CREATE TABLE email_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  address text NOT NULL,
  imap_host text NOT NULL,
  imap_port integer NOT NULL DEFAULT 993,
  imap_user text NOT NULL,
  imap_pass_enc text NOT NULL,
  imap_tls boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, address)
);

CREATE INDEX email_channels_tenant_idx ON email_channels (tenant_id, enabled);

ALTER TABLE email_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_channels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_email_channels ON email_channels
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);