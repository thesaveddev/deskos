-- DeskOS schema: ad-hoc (unmanaged) support sessions.
-- A technician generates a short-lived code/link for a contact who has no
-- enrolled device. The contact's portable helper redeems the code, which
-- creates an ephemeral device + remote session in the tenant. The code is
-- stored only as a sha256 hash; the public claim path reads it through a
-- transaction-local setting (mirrors 0008's device-token read path) so RLS
-- still applies to every other query.

CREATE TABLE adhoc_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'claimed', 'connected', 'ended', 'expired')),
  permissions text[] NOT NULL DEFAULT '{view_screen}',
  reason text NOT NULL DEFAULT '',
  requested_by uuid NOT NULL REFERENCES users(id),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  remote_session_id uuid REFERENCES remote_sessions(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX adhoc_sessions_tenant_idx ON adhoc_sessions (tenant_id, created_at DESC);

ALTER TABLE adhoc_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE adhoc_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_adhoc_sessions ON adhoc_sessions
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR code_hash = NULLIF(current_setting('app.adhoc_code_hash', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
