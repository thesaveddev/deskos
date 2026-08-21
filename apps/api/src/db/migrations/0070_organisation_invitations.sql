-- ReyDesk schema: secure organisation invitation links.
-- Raw tokens are emailed once; only SHA-256 hashes are stored.

CREATE TABLE IF NOT EXISTS organisation_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  membership_id uuid NOT NULL REFERENCES memberships(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organisation_invitations_active_idx
  ON organisation_invitations (token_hash, expires_at)
  WHERE accepted_at IS NULL;
CREATE INDEX IF NOT EXISTS organisation_invitations_membership_idx
  ON organisation_invitations (membership_id, created_at DESC);
