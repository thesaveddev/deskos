-- DeskOS schema: sticky notes (personal notes per user, tenant-scoped)

CREATE TABLE notes (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'yellow',
  position_x int NOT NULL DEFAULT 40,
  position_y int NOT NULL DEFAULT 40,
  width int NOT NULL DEFAULT 260,
  height int NOT NULL DEFAULT 260,
  is_pinned boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_notes_tenant_user ON notes(tenant_id, user_id);
