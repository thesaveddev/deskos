-- DeskOS schema: Phase 1 M1 (identity, tenancy, RBAC scaffolding, audit, notifications)
-- Tenant-scoped tables use row-level security on tenant_id; app sets app.tenant_id per txn.

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Platform identity (global, not tenant-scoped, no RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  password_hash text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invited', 'disabled')),
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret text,
  locale text NOT NULL DEFAULT 'en',
  tz text NOT NULL DEFAULT 'UTC',
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  region text NOT NULL DEFAULT 'default',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_role text NOT NULL DEFAULT 'end_user',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'invited', 'disabled')),
  invited_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  device_fp text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

-- Platform-level auth telemetry (brute-force / suspicious-login detection).
-- Not tenant-scoped; never exposed through tenant APIs.
CREATE TABLE auth_attempts (
  id bigserial PRIMARY KEY,
  email citext NOT NULL,
  ip text,
  success boolean NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_attempts_email_idx ON auth_attempts (email, created_at DESC);

-- ---------------------------------------------------------------------------
-- RBAC scaffolding (tenant-scoped, RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE device_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  match_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  parent_id uuid REFERENCES device_groups(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX device_groups_tenant_idx ON device_groups (tenant_id);

CREATE TABLE grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  permission text NOT NULL,
  scope_type text,
  scope_id uuid,
  granted_by uuid REFERENCES users(id),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX grants_tenant_idx ON grants (tenant_id);

-- ---------------------------------------------------------------------------
-- Audit & notifications (tenant-scoped, RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type text NOT NULL DEFAULT 'user',
  actor_id uuid,
  action text NOT NULL,
  object_type text,
  object_id text,
  ip text,
  user_agent text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  prev_hash text NOT NULL,
  entry_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_tenant_idx ON audit_logs (tenant_id, created_at DESC);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  subject_type text,
  subject_id text,
  body text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row-level security: force on the owner too, deny-by-default when
-- app.tenant_id is unset. NULLIF guards against the empty-string session
-- value that remains after a local set_config transaction commits.
-- ---------------------------------------------------------------------------

ALTER TABLE device_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_device_groups ON device_groups
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_grants ON grants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_audit_logs ON audit_logs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_notifications ON notifications
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
