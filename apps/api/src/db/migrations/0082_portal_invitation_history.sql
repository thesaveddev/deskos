-- ReyDesk schema: portal invitation delivery history.
CREATE TABLE IF NOT EXISTS portal_invitation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  recipient_email text NOT NULL,
  portal_url text NOT NULL,
  personal_message text NOT NULL DEFAULT '',
  delivery_status text NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued', 'sent', 'not_configured', 'failed')),
  job_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS portal_invitation_history_tenant_idx
  ON portal_invitation_history (tenant_id, created_at DESC);

ALTER TABLE portal_invitation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invitation_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_portal_invitation_history ON portal_invitation_history;
CREATE POLICY tenant_isolation_portal_invitation_history ON portal_invitation_history
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
