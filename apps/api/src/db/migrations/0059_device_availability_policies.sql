-- DeskOS schema: policy-driven endpoint availability.
-- Availability is deliberately separate from metric rule evaluation: a bad
-- availability policy must never prevent telemetry from being recorded.

CREATE TABLE IF NOT EXISTS device_availability_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  group_id uuid REFERENCES device_groups(id) ON DELETE CASCADE,
  device_type text,
  priority integer NOT NULL DEFAULT 0,
  offline_threshold_minutes integer NOT NULL DEFAULT 30,
  grace_period_minutes integer NOT NULL DEFAULT 0,
  alert_delay_minutes integer NOT NULL DEFAULT 0,
  ticket_delay_minutes integer NOT NULL DEFAULT 30,
  ticket_mode text NOT NULL DEFAULT 'alert' CHECK (ticket_mode IN ('alert', 'ticket')),
  timezone text NOT NULL DEFAULT 'UTC',
  business_hours_id uuid REFERENCES business_hours(id) ON DELETE SET NULL,
  maintenance_windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  suppress_power_states jsonb NOT NULL DEFAULT '["battery"]'::jsonb,
  critical_override boolean NOT NULL DEFAULT false,
  recovery_notifications boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (group_id IS NOT NULL OR device_type IS NOT NULL OR (group_id IS NULL AND device_type IS NULL)),
  CHECK (offline_threshold_minutes BETWEEN 1 AND 43200),
  CHECK (grace_period_minutes BETWEEN 0 AND 10080),
  CHECK (alert_delay_minutes BETWEEN 0 AND 10080),
  CHECK (ticket_delay_minutes BETWEEN 0 AND 43200),
  CHECK (device_type IS NULL OR device_type IN ('laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'))
);
CREATE INDEX IF NOT EXISTS device_availability_policy_scope_idx
  ON device_availability_policies (tenant_id, enabled, group_id, device_type, priority DESC);

ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS availability_policy_id uuid REFERENCES device_availability_policies(id) ON DELETE SET NULL;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS ticket_due_at timestamptz;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS availability_alert boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS device_alerts_availability_due_idx
  ON device_alerts (tenant_id, availability_alert, resolved_at, ticket_due_at)
  WHERE availability_alert = true;

ALTER TABLE device_availability_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_availability_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_device_availability_policies ON device_availability_policies;
CREATE POLICY tenant_isolation_device_availability_policies ON device_availability_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
