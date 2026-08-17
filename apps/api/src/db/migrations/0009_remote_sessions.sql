-- DeskOS schema: remote-support control plane foundation.

CREATE TABLE remote_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('attended', 'unattended', 'inspection')),
  state text NOT NULL DEFAULT 'requested'
    CHECK (state IN ('requested', 'consent_pending', 'connecting', 'active', 'reconnecting', 'ended', 'denied', 'expired')),
  permissions text[] NOT NULL DEFAULT '{}',
  reason text NOT NULL DEFAULT '',
  requested_by uuid NOT NULL REFERENCES users(id),
  consented_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX remote_sessions_tenant_idx ON remote_sessions (tenant_id, created_at DESC);
CREATE INDEX remote_sessions_device_idx ON remote_sessions (tenant_id, device_id, created_at DESC);
CREATE INDEX remote_sessions_ticket_idx ON remote_sessions (tenant_id, ticket_id, created_at DESC);
CREATE INDEX remote_sessions_state_idx ON remote_sessions (tenant_id, state, created_at DESC);

CREATE TABLE session_join_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('technician', 'agent')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_join_tokens_session_idx ON session_join_tokens (session_id, audience, expires_at);

CREATE TABLE session_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  actor_type text NOT NULL DEFAULT 'user',
  actor_id uuid,
  event text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_events_session_idx ON session_events (session_id, created_at);

ALTER TABLE remote_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE remote_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_remote_sessions ON remote_sessions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE session_join_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_join_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_session_join_tokens ON session_join_tokens
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_session_events ON session_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
