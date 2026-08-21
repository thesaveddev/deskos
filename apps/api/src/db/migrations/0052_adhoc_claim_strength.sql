-- Stronger ad-hoc support claims.
-- Numeric support codes remain available, while emailed links use a separate
-- high-entropy token and bind the first successful claim to a client fingerprint.
ALTER TABLE adhoc_sessions
  ADD COLUMN IF NOT EXISTS claim_mode text NOT NULL DEFAULT 'code',
  ADD COLUMN IF NOT EXISTS claim_token_hash text,
  ADD COLUMN IF NOT EXISTS claim_token_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_fingerprint_hash text;

ALTER TABLE adhoc_sessions
  DROP CONSTRAINT IF EXISTS adhoc_sessions_claim_mode_check;
ALTER TABLE adhoc_sessions
  ADD CONSTRAINT adhoc_sessions_claim_mode_check
  CHECK (claim_mode IN ('code', 'email_link'));

CREATE UNIQUE INDEX IF NOT EXISTS adhoc_sessions_claim_token_uq
  ON adhoc_sessions (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;
