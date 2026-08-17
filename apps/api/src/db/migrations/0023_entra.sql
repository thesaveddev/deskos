-- DeskOS schema: Entra ID / Microsoft 365 integration (tenant-scoped, RLS).
-- Client secrets are stored AES-256-GCM encrypted (see core/crypto.ts) and never
-- returned by the API; only a masked marker is exposed.

CREATE TABLE entra_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  azure_tenant_id text NOT NULL,
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE INDEX entra_connections_tenant_idx ON entra_connections (tenant_id, enabled);

ALTER TABLE entra_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE entra_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_entra_connections ON entra_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Directory sync history.
CREATE TABLE directory_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES entra_connections(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'ok', 'partial', 'error')),
  fetched integer NOT NULL DEFAULT 0,
  created integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX directory_sync_runs_tenant_idx ON directory_sync_runs (tenant_id, started_at DESC);

ALTER TABLE directory_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE directory_sync_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_directory_sync_runs ON directory_sync_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Audit log for gated account actions (password reset, MFA status change, etc.).
CREATE TABLE entra_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES entra_connections(id) ON DELETE SET NULL,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  target_upn text NOT NULL,
  status text NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'ok', 'error')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX entra_actions_tenant_idx ON entra_actions (tenant_id, created_at DESC);

ALTER TABLE entra_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE entra_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_entra_actions ON entra_actions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Directory: end-users/requesters, populated from Entra directory sync.
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'end_user'
    CHECK (type IN ('end_user', 'requester', 'vendor')),
  name text NOT NULL,
  email citext NOT NULL,
  phone text,
  department text,
  site text,
  account_status text NOT NULL DEFAULT 'active',
  is_vip boolean NOT NULL DEFAULT false,
  ext_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX contacts_tenant_idx ON contacts (tenant_id, email);
CREATE INDEX contacts_ext_identity_idx ON contacts (tenant_id, (ext_identity->>'objectId'));

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_contacts ON contacts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
