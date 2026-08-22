-- ReyDesk schema: team chat file sharing.
-- Files belong to a chat message and are stored under the configured upload root.
-- The database stores metadata only; every access remains room-membership checked.

CREATE TABLE chat_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_attachments_room_idx ON chat_attachments (room_id, created_at);
CREATE INDEX chat_attachments_message_idx ON chat_attachments (message_id);

ALTER TABLE chat_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_attachments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_chat_attachments ON chat_attachments
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
