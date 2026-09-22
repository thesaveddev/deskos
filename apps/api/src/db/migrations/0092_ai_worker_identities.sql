-- Per-worker machine identity and least-privilege access review.
-- Identities are descriptive governance records; execution still goes through
-- the tenant tool-permission matrix and approval gates.
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS machine_identity text NOT NULL DEFAULT 'reydesk-worker';
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS allowed_tools text[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS access_reviewed_at timestamptz;
ALTER TABLE ai_playbooks ADD COLUMN IF NOT EXISTS access_reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ai_playbooks_access_review_idx
  ON ai_playbooks (tenant_id, access_reviewed_at);
