-- DeskOS schema: richer endpoint health telemetry.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS power_source text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_pct numeric(5,2);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS uptime_seconds bigint;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_inventory_at timestamptz;

ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS disk_free_bytes bigint;
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS network_latency_ms numeric(8,2);
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS battery_pct numeric(5,2);
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS uptime_seconds bigint;
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS process_count integer;
ALTER TABLE device_metrics ADD COLUMN IF NOT EXISTS recorded_reason text NOT NULL DEFAULT 'periodic';
