-- DeskOS schema: assets (CMDB-lite) and licences.
-- assets carry a per-tenant unique tag, lifecycle status, ownership, location,
-- supplier/warranty, a JSON purchase blob, and an optional link to an enrolled
-- device. licences are tracked against an asset (or standalone) with seat and
-- expiry data. Both tables are tenant-scoped and RLS-enforced.

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tag text NOT NULL,
  type text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'in_use',
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  location text,
  supplier text,
  warranty_until date,
  purchase jsonb NOT NULL DEFAULT '{}'::jsonb,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  ext jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tag)
);
CREATE INDEX assets_tenant_idx ON assets (tenant_id, status, type);
CREATE INDEX assets_device_idx ON assets (tenant_id, device_id);

CREATE TABLE licences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id uuid REFERENCES assets(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_ref text NOT NULL DEFAULT '',
  seats_used integer NOT NULL DEFAULT 0,
  seats_total integer NOT NULL DEFAULT 0,
  expires_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX licences_tenant_idx ON licences (tenant_id, asset_id);
CREATE INDEX licences_expiry_idx ON licences (tenant_id, expires_at);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE licences ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
ALTER TABLE licences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_assets ON assets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_licences ON licences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
