-- Public API security controls and tenant-scoped usage analytics.
-- An empty/disabled allowlist preserves current behaviour. When enabled,
-- only matching CIDR entries may use OAuth-backed public API resources.

CREATE TABLE IF NOT EXISTS api_security_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ip_allowlist_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_ip_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cidr text NOT NULL,
  label text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, cidr)
);
CREATE INDEX IF NOT EXISTS api_ip_allowlist_tenant_idx ON api_ip_allowlist (tenant_id, enabled);

CREATE TABLE IF NOT EXISTS api_usage_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid REFERENCES oauth_clients(id) ON DELETE SET NULL,
  method text NOT NULL,
  path text NOT NULL,
  status_code int NOT NULL DEFAULT 200,
  source_ip text,
  duration_ms int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_usage_events_tenant_time_idx ON api_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_usage_events_tenant_path_idx ON api_usage_events (tenant_id, path, created_at DESC);

ALTER TABLE api_security_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_security_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_api_security_settings ON api_security_settings;
CREATE POLICY tenant_isolation_api_security_settings ON api_security_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE api_ip_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_ip_allowlist FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_api_ip_allowlist ON api_ip_allowlist;
CREATE POLICY tenant_isolation_api_ip_allowlist ON api_ip_allowlist
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE api_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_api_usage_events ON api_usage_events;
CREATE POLICY tenant_isolation_api_usage_events ON api_usage_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
