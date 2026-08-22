-- Explicit membership for organization chat rooms.
-- Organization rooms remain open to the tenant while this table has no rows
-- for the room. Adding the first member makes the room restricted to the
-- selected members plus its creator and organization managers.

CREATE TABLE IF NOT EXISTS chat_room_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_room_members_tenant_room_idx
  ON chat_room_members (tenant_id, room_id, created_at);
CREATE INDEX IF NOT EXISTS chat_room_members_tenant_user_idx
  ON chat_room_members (tenant_id, user_id);

ALTER TABLE chat_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_room_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_chat_room_members ON chat_room_members;
CREATE POLICY tenant_isolation_chat_room_members ON chat_room_members
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
