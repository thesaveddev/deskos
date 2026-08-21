-- DeskOS schema: passwordless magic-link authentication
-- Tokens are global auth records because they are consumed before a tenant
-- context exists. Only SHA-256 hashes are stored; raw tokens are emailed once.

CREATE TABLE magic_link_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  requested_ip text,
  requested_user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX magic_link_tokens_lookup_idx ON magic_link_tokens (token_hash, expires_at)
  WHERE consumed_at IS NULL;
CREATE INDEX magic_link_tokens_user_idx ON magic_link_tokens (user_id, created_at DESC);
