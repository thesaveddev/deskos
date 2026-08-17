-- DeskOS schema: on-prem Active Directory (LDAP/ADSI) integration.
-- Mirrors the Entra/M365 integration: encrypted bind credentials, a directory
-- sync history, and an audited log of gated account actions. All tables are
-- tenant-scoped and RLS-enforced.

CREATE TABLE ad_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 389,
  use_ssl boolean NOT NULL DEFAULT false,
  base_dn text NOT NULL,
  bind_dn text NOT NULL,
  bind_password_enc text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX ad_connections_tenant_idx ON ad_connections (tenant_id, enabled);

ALTER TABLE ad_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ad_connections ON ad_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE ad_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES ad_connections(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'partial', 'error')),
  fetched integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX ad_sync_runs_tenant_idx ON ad_sync_runs (tenant_id, started_at DESC);

ALTER TABLE ad_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ad_sync_runs ON ad_sync_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE ad_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES ad_connections(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_upn text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'ok', 'error')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ad_actions_tenant_idx ON ad_actions (tenant_id, created_at DESC);

ALTER TABLE ad_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ad_actions ON ad_actions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
