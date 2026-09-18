-- Asset expiry notices: dedupe ledger for warranty/licence expiry emails.
--
-- The expiry sweep runs periodically; each (kind, asset, due date) pair must
-- notify at most once. If the date is later extended, the new date is a new
-- pair and a fresh notice can fire. Asset deletion cascades the rows away.
CREATE TABLE asset_expiry_notices (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('warranty', 'licence')),
  asset_id uuid NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  licence_id uuid REFERENCES licences(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, asset_id, due_date)
);
CREATE INDEX asset_expiry_notices_tenant_idx ON asset_expiry_notices (tenant_id, notified_at DESC);

ALTER TABLE asset_expiry_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_expiry_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_asset_expiry_notices ON asset_expiry_notices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
