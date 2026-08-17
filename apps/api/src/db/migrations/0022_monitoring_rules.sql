-- DeskOS schema: Phase 2 endpoint monitoring rules.
-- Rules are evaluated when an agent reports telemetry. Alerts remain in the
-- existing device_alerts feed so operators have one source of truth.

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  metric text NOT NULL CHECK (metric IN ('cpu_pct', 'mem_pct', 'disk_pct')),
  condition jsonb NOT NULL,
  action jsonb NOT NULL,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  group_id uuid REFERENCES device_groups(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (device_id IS NULL OR group_id IS NULL)
);
CREATE INDEX alert_rules_tenant_idx ON alert_rules (tenant_id, enabled, metric);
CREATE INDEX alert_rules_device_idx ON alert_rules (tenant_id, device_id) WHERE device_id IS NOT NULL;
CREATE INDEX alert_rules_group_idx ON alert_rules (tenant_id, group_id) WHERE group_id IS NOT NULL;

ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS rule_id uuid REFERENCES alert_rules(id) ON DELETE SET NULL;
ALTER TABLE device_alerts DROP CONSTRAINT IF EXISTS device_alerts_kind_check;
ALTER TABLE device_alerts ADD CONSTRAINT device_alerts_kind_check
  CHECK (kind IN ('offline', 'low_disk', 'high_cpu', 'high_mem', 'monitoring'));
DROP INDEX IF EXISTS device_alerts_open_uq;
CREATE UNIQUE INDEX device_alerts_open_uq
  ON device_alerts (device_id, kind, COALESCE(rule_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE resolved_at IS NULL;

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_alert_rules ON alert_rules
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
