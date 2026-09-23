-- ReyDesk schema: chat message editing and per-room read state.
-- Edited messages keep an edited_at marker so the room shows "(edited)"
-- instead of silently changing history. Read state powers unread badges:
-- one row per room per user, updated whenever the user views the room.

ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;

CREATE TABLE IF NOT EXISTS chat_room_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  last_read_message_id bigint,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS chat_room_reads_tenant_user_idx
  ON chat_room_reads (tenant_id, user_id);

ALTER TABLE chat_room_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_room_reads FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_chat_room_reads ON chat_room_reads;
CREATE POLICY tenant_isolation_chat_room_reads ON chat_room_reads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
