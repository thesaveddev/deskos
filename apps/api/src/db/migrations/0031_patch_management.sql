-- DeskOS schema: patch management (P3). A patch deployment is a signed
-- artifact (ed25519 signature) rolled out to a device scope through staged
-- rings, with an approval gate and per-device status tracking. The agent
-- verifies the sha256 + signature before applying (enforced in the agent,
-- surfaced + audited here).

CREATE TABLE patch_deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  version text NOT NULL,
  description text NOT NULL DEFAULT '',
  artifact_url text NOT NULL,
  sha256 text NOT NULL,
  signature text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'rolling_out', 'paused', 'completed', 'rejected', 'rolled_back')),
  scope_type text NOT NULL DEFAULT 'tenant' CHECK (scope_type IN ('tenant', 'device_group')),
  scope_id uuid,
  rings jsonb NOT NULL DEFAULT '[{"name":"Ring 1","percent":10},{"name":"Ring 2","percent":40},{"name":"Ring 3","percent":50}]'::jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patch_deployments_tenant_idx ON patch_deployments (tenant_id, created_at DESC);

CREATE TABLE patch_device_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  deployment_id uuid NOT NULL REFERENCES patch_deployments(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ring_index int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'offered', 'downloading', 'applying', 'succeeded', 'failed', 'rolled_back')),
  detail text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deployment_id, device_id)
);
CREATE INDEX patch_device_status_deployment_idx ON patch_device_status (deployment_id, status);
CREATE INDEX patch_device_status_device_idx ON patch_device_status (device_id);

ALTER TABLE patch_deployments ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_deployments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_patch_deployments ON patch_deployments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE patch_device_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE patch_device_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_patch_device_status ON patch_device_status
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
