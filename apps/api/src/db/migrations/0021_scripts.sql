-- DeskOS schema: script library + execution records.
-- scripts hold versioned, approval-gated script bodies; script_runs record
-- each execution attempt with args, exit code, and output reference. Both
-- tables are tenant-scoped and RLS-enforced.

CREATE TABLE scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  os text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  approval_status text NOT NULL DEFAULT 'draft'
    CHECK (approval_status IN ('draft', 'pending', 'approved', 'rejected')),
  body text NOT NULL DEFAULT '',
  args_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  privilege_level text NOT NULL DEFAULT 'user'
    CHECK (privilege_level IN ('user', 'elevated')),
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scripts_tenant_idx ON scripts (tenant_id, category, approval_status);

CREATE TABLE script_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  script_id uuid NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  session_id uuid REFERENCES remote_sessions(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  exit_code integer,
  output_ref text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX script_runs_script_idx ON script_runs (script_id, started_at DESC);
CREATE INDEX script_runs_actor_idx ON script_runs (tenant_id, actor_id, started_at DESC);

ALTER TABLE scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE scripts FORCE ROW LEVEL SECURITY;
ALTER TABLE script_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_scripts ON scripts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_script_runs ON script_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
