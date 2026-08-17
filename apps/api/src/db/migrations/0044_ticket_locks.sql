-- DeskOS schema: ticket locks (prevent concurrent editing by multiple agents)

CREATE TABLE ticket_locks (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  locked_by uuid NOT NULL REFERENCES users(id),
  locked_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '5 minutes'),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- Unique lock per ticket enforced in application code (now() is not IMMUTABLE for partial indexes)
CREATE INDEX idx_ticket_locks_tenant ON ticket_locks(tenant_id, ticket_id);

ALTER TABLE ticket_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_locks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_locks ON ticket_locks
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
