-- DeskOS schema: ticket escalation, forwarding, merge, and activity log

-- Escalation levels per tenant (configurable)
CREATE TABLE escalation_policies (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_status text NOT NULL DEFAULT 'open',
  target_status text NOT NULL DEFAULT 'escalated',
  trigger_after_minutes int NOT NULL DEFAULT 60,
  trigger_on_priority text[] DEFAULT '{}',
  target_team_id uuid REFERENCES teams(id),
  target_role text,
  auto_assign boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ticket escalation history
CREATE TABLE ticket_escalations (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  level int NOT NULL DEFAULT 1,
  from_team_id uuid REFERENCES teams(id),
  to_team_id uuid REFERENCES teams(id),
  from_assignee_id uuid REFERENCES users(id),
  to_assignee_id uuid REFERENCES users(id),
  reason text NOT NULL DEFAULT '',
  escalated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Ticket activity log (every meaningful action)
CREATE TABLE ticket_activity (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_ticket_escalations_ticket ON ticket_escalations(ticket_id, created_at DESC);
CREATE INDEX idx_ticket_activity_ticket ON ticket_activity(ticket_id, created_at DESC);

ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_esc_policies ON escalation_policies
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE ticket_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_escalations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_esc ON ticket_escalations
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE ticket_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_activity FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_act ON ticket_activity
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
