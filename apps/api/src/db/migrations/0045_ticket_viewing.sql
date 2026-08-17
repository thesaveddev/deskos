-- DeskOS schema: ticket viewing indicators + reduced lock TTL

-- Track who is currently viewing each ticket
CREATE TABLE ticket_viewers (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  viewing_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_viewers_ticket ON ticket_viewers(ticket_id);

-- Clean up stale viewers (called on read)
CREATE OR REPLACE FUNCTION cleanup_stale_viewers() RETURNS void AS $$
BEGIN
  DELETE FROM ticket_viewers WHERE viewing_at < now() - interval '2 minutes';
END;
$$ LANGUAGE plpgsql;

ALTER TABLE ticket_viewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_viewers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_viewers ON ticket_viewers
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
