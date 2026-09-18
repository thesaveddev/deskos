-- Device lifecycle: retirement and telemetry retention.
--
-- Retirement gives devices a soft-delete state so removal from the fleet no
-- longer destroys the audit trail (remote sessions, alerts, metrics are kept
-- for compliance), while hiding the device from the active inventory and
-- revoking its agent credential.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS retired_at timestamptz;
CREATE INDEX IF NOT EXISTS devices_retired_idx ON devices (tenant_id, retired_at);

-- device_metrics grows once per heartbeat per device forever; add a retention
-- horizon swept by the alert scheduler (default 30 days).
CREATE INDEX IF NOT EXISTS device_metrics_recorded_idx ON device_metrics (recorded_at);
