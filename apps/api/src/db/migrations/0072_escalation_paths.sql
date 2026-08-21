-- DeskOS schema: escalation paths (routing rules for the manual Escalate action)
-- An escalation path maps a matching source (team / category / priority) to a
-- target team and optional assignee, so technicians can route an escalation in
-- one click instead of re-entering the destination each time.

CREATE TABLE escalation_paths (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
  source_category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  source_priority text[] DEFAULT '{}',
  target_team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  target_assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  auto_assign boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  position int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX escalation_paths_tenant_idx ON escalation_paths (tenant_id, position);

ALTER TABLE escalation_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_paths FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_escalation_paths ON escalation_paths
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
