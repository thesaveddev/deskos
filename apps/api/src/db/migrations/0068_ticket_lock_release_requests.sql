-- DeskOS schema: auditable requests to release an active ticket lock.
CREATE TABLE ticket_lock_release_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  locked_by uuid NOT NULL REFERENCES users(id),
  message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users(id)
);

CREATE INDEX idx_ticket_lock_release_requests_ticket
  ON ticket_lock_release_requests (tenant_id, ticket_id, created_at DESC);
CREATE UNIQUE INDEX uq_ticket_lock_release_requests_pending
  ON ticket_lock_release_requests (ticket_id, requested_by)
  WHERE status = 'pending';

ALTER TABLE ticket_lock_release_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_lock_release_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_lock_release_requests ON ticket_lock_release_requests
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
