-- DeskOS schema: DEX experience signals and explainable scoring.
-- Raw experience data is retained separately from scoring so a scoring change
-- never destroys the evidence used to explain or recompute a result.

ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS network_packet_loss_pct numeric(5,2);

CREATE TABLE device_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  department text NOT NULL DEFAULT '',
  team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  location text NOT NULL DEFAULT '',
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX device_assignments_active_device_uq
  ON device_assignments (device_id) WHERE ended_at IS NULL;
CREATE INDEX device_assignments_scope_idx
  ON device_assignments (tenant_id, department, team_id, location, ended_at);

CREATE TABLE dex_experience_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  application_name text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('launch', 'crash', 'hang', 'close', 'login')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86_400_000),
  successful boolean,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dex_experience_events_device_idx
  ON dex_experience_events (tenant_id, device_id, occurred_at DESC);
CREATE INDEX dex_experience_events_app_idx
  ON dex_experience_events (tenant_id, application_name, occurred_at DESC);

CREATE TABLE dex_user_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dex_user_surveys_scope_idx
  ON dex_user_surveys (tenant_id, user_id, created_at DESC);

CREATE TABLE dex_scoring_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  device_type text,
  weights jsonb NOT NULL DEFAULT '{"performance":0.35,"availability":0.25,"security":0.25,"user_impact":0.15}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (device_type IS NULL OR device_type IN ('laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'))
);
CREATE INDEX dex_scoring_policies_scope_idx
  ON dex_scoring_policies (tenant_id, device_type, enabled);

ALTER TABLE device_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_assignments ON device_assignments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE dex_experience_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE dex_experience_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dex_experience_events ON dex_experience_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE dex_user_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE dex_user_surveys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dex_user_surveys ON dex_user_surveys
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE dex_scoring_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE dex_scoring_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_dex_scoring_policies ON dex_scoring_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
