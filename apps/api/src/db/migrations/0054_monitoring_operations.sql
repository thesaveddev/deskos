-- DeskOS schema: production monitoring operations.
-- Extends the threshold engine without coupling telemetry ingestion to alert actions.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_type text NOT NULL DEFAULT 'workstation';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_health_pct numeric(5,2);
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_device_type_check;
ALTER TABLE devices ADD CONSTRAINT devices_device_type_check
  CHECK (device_type IN ('laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'));

ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS battery_health_pct numeric(5,2);
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS service_states jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS device_type text;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS business_hours_id uuid REFERENCES business_hours(id) ON DELETE SET NULL;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS maintenance_windows jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS min_duration_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS service_name text;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS routing jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE alert_rules ADD COLUMN IF NOT EXISTS escalation jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
  CHECK (metric IN (
    'cpu_pct', 'mem_pct', 'disk_pct', 'battery_pct', 'battery_health_pct',
    'network_latency_ms', 'uptime_seconds', 'process_count',
    'heartbeat_age_seconds', 'service_state'
  ));
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_device_type_check
  CHECK (device_type IS NULL OR device_type IN ('laptop', 'workstation', 'server', 'network_device', 'mobile', 'other'));
CREATE INDEX IF NOT EXISTS alert_rules_type_idx ON alert_rules (tenant_id, device_type, enabled);
CREATE INDEX IF NOT EXISTS alert_rules_schedule_idx ON alert_rules (tenant_id, business_hours_id);

ALTER TABLE device_alerts DROP CONSTRAINT IF EXISTS device_alerts_kind_check;
ALTER TABLE device_alerts ADD CONSTRAINT device_alerts_kind_check
  CHECK (kind IN ('offline', 'low_disk', 'high_cpu', 'high_mem', 'monitoring', 'anomaly', 'service_state'));
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS acknowledged_at timestamptz;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS snoozed_until timestamptz;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0;
ALTER TABLE device_alerts ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
CREATE INDEX IF NOT EXISTS device_alerts_open_lifecycle_idx
  ON device_alerts (tenant_id, resolved_at, snoozed_until, created_at DESC);

CREATE TABLE IF NOT EXISTS device_presence_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('online', 'offline')),
  source text NOT NULL DEFAULT 'heartbeat',
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_presence_device_idx
  ON device_presence_events (tenant_id, device_id, observed_at DESC);
ALTER TABLE device_presence_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_presence_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_device_presence_events ON device_presence_events;
CREATE POLICY tenant_isolation_device_presence_events ON device_presence_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
