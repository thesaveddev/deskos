-- DeskOS schema: team membership and optional private team chat.
-- Existing chat rooms remain organization-wide when team_id is NULL.

ALTER TABLE chat_rooms
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES teams(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_team_uq
  ON chat_rooms (team_id)
  WHERE team_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX IF NOT EXISTS team_members_tenant_user_idx
  ON team_members (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS team_members_team_idx
  ON team_members (team_id, created_at);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_team_members ON team_members;
CREATE POLICY tenant_isolation_team_members ON team_members
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
