-- DeskOS schema: human-callable enrollment codes.
-- Codes are short-lived and single-use; opaque enrolment tokens remain available
-- for protected IT fleet deployment.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_code_hash text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_code_created_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_code_expires_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_code_used_at timestamptz;

CREATE INDEX IF NOT EXISTS tenants_enrol_code_hash_idx
  ON tenants (enrol_code_hash)
  WHERE enrol_code_hash IS NOT NULL;
