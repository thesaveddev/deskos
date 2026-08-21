-- DeskOS schema: production MFA recovery and first-login setup.
CREATE TABLE mfa_setup_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mfa_setup_tokens_active_idx ON mfa_setup_tokens (token_hash, expires_at) WHERE used_at IS NULL;

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX mfa_recovery_codes_user_idx ON mfa_recovery_codes (user_id, used_at);
