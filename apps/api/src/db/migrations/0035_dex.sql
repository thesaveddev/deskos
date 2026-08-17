-- DeskOS schema: DEX (digital employee experience) + security posture (P4).
-- device_dex_scores holds the latest 0-100 health/experience score per device,
-- with a component breakdown. posture_alerts records one open alert per
-- (device, check) when a device's reported security posture violates an
-- endpoint policy.

CREATE TABLE device_dex_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL UNIQUE REFERENCES devices(id) ON DELETE CASCADE,
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE posture_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  policy_id uuid REFERENCES endpoint_policies(id) ON DELETE CASCADE,
  check_path text NOT NULL,
  expected jsonb NOT NULL DEFAULT 'null'::jsonb,
  actual jsonb NOT NULL DEFAULT 'null'::jsonb,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE UNIQUE INDEX posture_open_uq ON posture_alerts (device_id, check_path) WHERE status = 'open';

ALTER TABLE device_dex_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_dex_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_dex_scores ON device_dex_scores
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE posture_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE posture_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_posture_alerts ON posture_alerts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
