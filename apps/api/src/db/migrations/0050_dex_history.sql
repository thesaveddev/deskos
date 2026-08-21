-- DeskOS schema: DEX history and posture-compliance reporting.
-- The latest score remains in device_dex_scores; this table stores a bounded
-- sampling of changes so trend views do not need to reconstruct history from
-- raw telemetry on every request.

CREATE TABLE device_dex_score_history (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  score int NOT NULL CHECK (score BETWEEN 0 AND 100),
  components jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX device_dex_history_device_idx
  ON device_dex_score_history (tenant_id, device_id, computed_at DESC);

ALTER TABLE device_dex_score_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_dex_score_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_dex_history ON device_dex_score_history
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
