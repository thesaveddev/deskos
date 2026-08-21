-- DeskOS schema: software licence assignment history.
CREATE TABLE licence_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  licence_id uuid NOT NULL REFERENCES licences(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  seats integer NOT NULL DEFAULT 1 CHECK (seats > 0),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX licence_assignments_active_uq
  ON licence_assignments (licence_id, user_id) WHERE ended_at IS NULL;
CREATE INDEX licence_assignments_user_idx
  ON licence_assignments (tenant_id, user_id, assigned_at DESC);

ALTER TABLE licence_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE licence_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_licence_assignments ON licence_assignments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
