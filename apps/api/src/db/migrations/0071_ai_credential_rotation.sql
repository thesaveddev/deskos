-- ReyDesk schema: tenant AI credential rotation metadata.

ALTER TABLE tenant_ai_settings
  ADD COLUMN IF NOT EXISTS api_key_version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS api_key_rotated_at timestamptz;
