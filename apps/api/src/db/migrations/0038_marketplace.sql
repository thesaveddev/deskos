-- DeskOS schema: developer marketplace (P4). `app_registry` is the shared,
-- platform-wide catalog of published apps (deliberately NOT tenant-scoped or
-- RLS-enforced — it is the marketplace every tenant browses, mirroring the
-- platform-level users/refresh_tokens tables). `app_installs` is tenant-scoped
-- and RLS-enforced: which apps this tenant has enabled.

CREATE TABLE app_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  developer text NOT NULL DEFAULT '',
  version text NOT NULL DEFAULT '1.0.0',
  icon_url text,
  -- Declared capabilities (e.g. ["remote.control", "tickets:read"]) so installs
  -- can be gated/displayed without executing anything.
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  install_count integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX app_registry_slug_idx ON app_registry (slug);

CREATE TABLE app_installs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES app_registry(id) ON DELETE CASCADE,
  installed_by uuid NOT NULL REFERENCES users(id),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, app_id)
);
CREATE INDEX app_installs_tenant_idx ON app_installs (tenant_id);

ALTER TABLE app_installs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_installs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_app_installs ON app_installs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
