-- DeskOS schema: monitoring rules for richer endpoint health telemetry.
-- CPU, memory, and disk rules remain supported; these fields are now ruleable too.
ALTER TABLE alert_rules DROP CONSTRAINT IF EXISTS alert_rules_metric_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_metric_check
  CHECK (metric IN (
    'cpu_pct', 'mem_pct', 'disk_pct',
    'battery_pct', 'network_latency_ms', 'uptime_seconds', 'process_count'
  ));
