-- DeskOS schema: Phase 1 M3 (devices & agent v1)
-- NOTE: device_groups (with match_rules + parent_id) is already defined in 0001;
-- M3 adds the devices themselves, metrics, alerts, enrolment tokens, and the
-- ticket<->device link.

-- Enforce unique group names per tenant (additive; 0001 had no constraint).
CREATE UNIQUE INDEX IF NOT EXISTS device_groups_name_uq
  ON device_groups (tenant_id, name);

-- ---------------------------------------------------------------------------
-- Enrolment token: a single tenant-scoped secret agents present to enrol.
-- Stored as a sha256 hash on the (unprotected) tenants table so the enrolment
-- lookup works globally, exactly like the existing tenant-discovery queries.
-- Only the hash is stored; the plaintext is shown once on rotation.
-- ---------------------------------------------------------------------------

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_token_hash text;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_token_label text NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_token_created_by uuid REFERENCES users(id);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_token_created_at timestamptz;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS enrol_token_revoked_at timestamptz;

-- ---------------------------------------------------------------------------
-- Devices (tenant-scoped, RLS). Agent auth uses the per-device token hash;
-- display status is derived from last_seen_at against the offline threshold.
-- ---------------------------------------------------------------------------

CREATE TABLE devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id uuid REFERENCES device_groups(id) ON DELETE SET NULL,
  name text NOT NULL,
  hostname text NOT NULL DEFAULT '',
  os text NOT NULL DEFAULT '',
  os_version text NOT NULL DEFAULT '',
  arch text NOT NULL DEFAULT '',
  ip_address text NOT NULL DEFAULT '',
  agent_version text NOT NULL DEFAULT '',
  agent_token_hash text,
  enrolled_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX devices_tenant_idx ON devices (tenant_id, created_at DESC);
CREATE INDEX devices_tenant_group_idx ON devices (tenant_id, group_id);
CREATE INDEX devices_last_seen_idx ON devices (tenant_id, last_seen_at DESC);

-- ---------------------------------------------------------------------------
-- Metrics samples (CPU/mem/disk %) for sparklines and alert evaluation.
-- ---------------------------------------------------------------------------

CREATE TABLE device_metrics (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  cpu_pct numeric(5,2) NOT NULL,
  mem_pct numeric(5,2) NOT NULL,
  disk_pct numeric(5,2) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_metrics_device_idx ON device_metrics (device_id, recorded_at DESC);

-- ---------------------------------------------------------------------------
-- Device alerts (offline / low_disk / ...). At most one OPEN alert per
-- device+kind; a new alert for the same condition waits for the previous one
-- to be resolved (back online / disk freed). Auto-created tickets link here.
-- ---------------------------------------------------------------------------

CREATE TABLE device_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('offline', 'low_disk', 'high_cpu', 'high_mem')),
  severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  message text NOT NULL,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_alerts_tenant_idx ON device_alerts (tenant_id, created_at DESC);
CREATE INDEX device_alerts_device_idx ON device_alerts (device_id, created_at DESC);
CREATE UNIQUE INDEX device_alerts_open_uq ON device_alerts (device_id, kind) WHERE resolved_at IS NULL;

-- Link auto-created (and technician-created) tickets to a device so the ticket
-- and the device live in the same workspace.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS tickets_tenant_device_idx ON tickets (tenant_id, device_id);

-- ---------------------------------------------------------------------------
-- Row-level security (same deny-by-default pattern as 0001/0002).
-- device_groups + its policy already exist from 0001. tenants is unprotected
-- by design (global discovery) and now carries only the enrol-token hash.
-- ---------------------------------------------------------------------------

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_devices ON devices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_metrics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_metrics ON device_metrics
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE device_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_alerts ON device_alerts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
