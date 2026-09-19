-- Needs-attention digest: dedupe ledger for the combined digest email.
--
-- The digest sweep runs periodically and sends one email per eligible
-- recipient summarising overdue KB reviews, upcoming asset expiries, and open
-- device alerts. Each (tenant, recipient, day) pair sends at most once —
-- a new day is a new pair and the digest fires again. Tenant deletion
-- cascades the rows away.
CREATE TABLE needs_attention_digests (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  item_count integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, recipient_id, digest_date)
);
CREATE INDEX needs_attention_digests_tenant_idx ON needs_attention_digests (tenant_id, sent_at DESC);

ALTER TABLE needs_attention_digests ENABLE ROW LEVEL SECURITY;
ALTER TABLE needs_attention_digests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_needs_attention_digests ON needs_attention_digests
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
