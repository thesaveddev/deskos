-- Lifecycle controls for per-worker machine identities.
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS identity_status text NOT NULL DEFAULT 'active'
  CHECK (identity_status IN ('active', 'revoked'));
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS identity_version int NOT NULL DEFAULT 1;
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS identity_rotated_at timestamptz;
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS identity_revoked_at timestamptz;
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS identity_revoked_reason text;

CREATE INDEX IF NOT EXISTS ai_playbooks_identity_status_idx
  ON ai_playbooks (tenant_id, identity_status);
