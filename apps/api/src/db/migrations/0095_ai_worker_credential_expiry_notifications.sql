ALTER TABLE ai_worker_identity_credentials
  ADD COLUMN IF NOT EXISTS expiry_notified_at timestamptz;

CREATE INDEX IF NOT EXISTS ai_worker_identity_credentials_notification_idx
  ON ai_worker_identity_credentials (tenant_id, expiry_notified_at, expires_at);
