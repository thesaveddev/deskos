-- DeskOS schema: OAuth2 public API (P3). Registered clients issue
-- client-credentials or authorization-code (PKCE S256) access tokens.
-- Client secrets and authorization codes are stored as sha256 hashes only.

CREATE TABLE oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  client_secret_hash text NOT NULL,
  redirect_uris text[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{}',
  grant_types text[] NOT NULL DEFAULT '{client_credentials}',
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_clients_tenant_idx ON oauth_clients (tenant_id);

CREATE TABLE oauth_auth_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  redirect_uri text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256' CHECK (code_challenge_method IN ('S256')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_auth_codes_hash_idx ON oauth_auth_codes (code_hash);

ALTER TABLE oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_clients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_clients ON oauth_clients
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE oauth_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_auth_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_oauth_auth_codes ON oauth_auth_codes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Public /oauth/token runs before a tenant is known, so it reads clients and
-- auth codes through a dedicated local setting (mirrors the device token-hash
-- read path in 0008). Write/tenant policies are unaffected.
CREATE POLICY oauth_client_secret_lookup ON oauth_clients FOR SELECT
  USING (current_setting('app.oauth_client_lookup', true) = 'on');

CREATE POLICY oauth_code_lookup ON oauth_auth_codes FOR SELECT
  USING (current_setting('app.oauth_code_lookup', true) = 'on');
CREATE POLICY oauth_code_consume ON oauth_auth_codes FOR UPDATE
  USING (current_setting('app.oauth_code_lookup', true) = 'on')
  WITH CHECK (current_setting('app.oauth_code_lookup', true) = 'on');
