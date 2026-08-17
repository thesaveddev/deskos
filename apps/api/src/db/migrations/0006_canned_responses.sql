-- DeskOS schema: Phase 1 M2 deferred — canned responses (tenant-scoped, RLS)

CREATE TABLE canned_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  shortcut text NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shortcut)
);
CREATE INDEX canned_responses_tenant_name_idx ON canned_responses (tenant_id, lower(name));

ALTER TABLE canned_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE canned_responses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_canned_responses ON canned_responses
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
