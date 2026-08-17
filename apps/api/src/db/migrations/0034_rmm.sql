-- DeskOS schema: RMM-grade endpoint management (P4). Structured device
-- inventory (HW/OS/apps/security posture, reported by the agent daily + on
-- change), endpoint policy profiles, and a bulk device-action queue.

CREATE TABLE device_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  hardware jsonb NOT NULL DEFAULT '{}'::jsonb,
  os jsonb NOT NULL DEFAULT '{}'::jsonb,
  apps jsonb NOT NULL DEFAULT '[]'::jsonb,
  security_posture jsonb NOT NULL DEFAULT '{}'::jsonb,
  collected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE endpoint_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  group_id uuid REFERENCES device_groups(id) ON DELETE CASCADE,
  posture_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  reboot_window jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX endpoint_policies_tenant_idx ON endpoint_policies (tenant_id);

CREATE TABLE device_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('restart', 'run_script', 'collect_inventory')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed', 'cancelled')),
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX device_actions_device_idx ON device_actions (device_id, created_at DESC);
CREATE INDEX device_actions_tenant_idx ON device_actions (tenant_id, status, created_at DESC);

ALTER TABLE device_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_inventory ON device_inventory
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE endpoint_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE endpoint_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_endpoint_policies ON endpoint_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_actions ON device_actions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
