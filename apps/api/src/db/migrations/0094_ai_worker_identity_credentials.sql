-- External credentials are shown only once at issuance. Runtime consumers store
-- only the SHA-256 hash and the prefix used for safe identification.
CREATE TABLE IF NOT EXISTS ai_worker_identity_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  playbook_id uuid NOT NULL REFERENCES ai_playbooks(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  usage_count int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_worker_identity_credentials_playbook_idx
  ON ai_worker_identity_credentials (tenant_id, playbook_id, status);
CREATE INDEX IF NOT EXISTS ai_worker_identity_credentials_expiry_idx
  ON ai_worker_identity_credentials (tenant_id, expires_at);

ALTER TABLE ai_worker_identity_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_worker_identity_credentials FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_worker_identity_credentials ON ai_worker_identity_credentials;
CREATE POLICY tenant_isolation_ai_worker_identity_credentials ON ai_worker_identity_credentials
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
