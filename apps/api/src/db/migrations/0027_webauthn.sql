-- DeskOS schema: WebAuthn/passkey credentials (M5/P2).
-- Credentials are platform-level (a user's passkey spans every tenant they
-- belong to), mirroring users/refresh_tokens, so there is no tenant_id or RLS.

ALTER TABLE users ADD COLUMN IF NOT EXISTS webauthn_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[] NOT NULL DEFAULT '{}',
  device_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX webauthn_credentials_user_idx ON webauthn_credentials (user_id);
