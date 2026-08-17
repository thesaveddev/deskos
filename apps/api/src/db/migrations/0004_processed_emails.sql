-- DeskOS schema: email-to-ticket deduplication (tenant-scoped, RLS)

CREATE TABLE processed_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  from_address text NOT NULL,
  subject text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, message_id)
);
CREATE INDEX processed_emails_tenant_idx ON processed_emails (tenant_id, processed_at DESC);

ALTER TABLE processed_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_processed_emails ON processed_emails
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);