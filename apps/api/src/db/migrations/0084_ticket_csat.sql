-- ReyDesk schema: ticket satisfaction (CSAT) ratings.
-- One optional rating per ticket, given by the requester after resolution.
CREATE TABLE IF NOT EXISTS ticket_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment text NOT NULL DEFAULT '',
  rated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id)
);

CREATE INDEX IF NOT EXISTS ticket_ratings_tenant_idx
  ON ticket_ratings (tenant_id, created_at DESC);

ALTER TABLE ticket_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_ratings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_ratings ON ticket_ratings;
CREATE POLICY tenant_isolation_ticket_ratings ON ticket_ratings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);