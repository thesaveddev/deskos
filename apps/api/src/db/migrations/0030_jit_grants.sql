-- DeskOS schema: JIT privileged access (P3). Extends the 0001 `grants` table
-- (subject_type/subject_id = grantee, permission, scope_type/scope_id,
-- granted_by, expires_at) with an approval + checkout/check-in lifecycle.
-- "Vaultless": no credentials are stored — a grant is a time-boxed permission
-- override that the technician checks out before use and checks in after.

ALTER TABLE grants ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE grants ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
  CHECK (status IN ('pending', 'approved', 'denied', 'revoked', 'expired', 'active'));
ALTER TABLE grants ADD COLUMN IF NOT EXISTS requested_by uuid REFERENCES users(id);
ALTER TABLE grants ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS denied_at timestamptz;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS checked_out_at timestamptz;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS checked_in_at timestamptz;
ALTER TABLE grants ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS grants_tenant_status_idx ON grants (tenant_id, status, expires_at);
CREATE INDEX IF NOT EXISTS grants_subject_idx ON grants (subject_id, permission, status);
