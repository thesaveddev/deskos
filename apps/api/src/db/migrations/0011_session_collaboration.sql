-- DeskOS schema: session chat and collaboration.
-- Chat history is persisted and audited; participants track owner/technician/observer
-- membership for invite and ownership transfer. Both tables are tenant-scoped + RLS.

CREATE TABLE session_messages (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  sender_type text NOT NULL CHECK (sender_type IN ('technician', 'agent', 'system')),
  sender_id uuid,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_messages_session_idx ON session_messages (session_id, created_at);

CREATE TABLE session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'technician' CHECK (role IN ('owner', 'technician', 'observer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, user_id)
);
CREATE INDEX session_participants_session_idx ON session_participants (session_id);

ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_session_messages ON session_messages
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE session_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_participants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_session_participants ON session_participants
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
