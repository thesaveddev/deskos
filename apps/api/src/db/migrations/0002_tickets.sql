-- DeskOS schema: Phase 1 M2 (ticketing, SLA, teams, categories)

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ticket_counter integer NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Teams, categories, business hours, SLA policies (tenant-scoped, RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  lead_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES categories(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_name_uq
  ON categories (tenant_id, name, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Default',
  -- Empty schedule = 24/7. Otherwise { "mon": {"start":"09:00","end":"17:30"}, ... } (UTC).
  schedule jsonb NOT NULL DEFAULT '{}'::jsonb,
  holidays jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sla_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  business_hours_id uuid REFERENCES business_hours(id),
  is_default boolean NOT NULL DEFAULT false,
  -- { "p1": {"response_mins": 30, "resolution_mins": 240}, "p2": {...}, ... }
  matrix jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Tickets + threads (tenant-scoped, RLS)
-- ---------------------------------------------------------------------------

CREATE TABLE tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  number integer NOT NULL,
  type text NOT NULL DEFAULT 'incident'
    CHECK (type IN ('incident', 'service_request', 'question', 'problem')),
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'open', 'in_progress', 'pending_user', 'pending_vendor',
                      'escalated', 'resolved', 'closed')),
  priority text NOT NULL DEFAULT 'p3' CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  impact text NOT NULL DEFAULT 'medium' CHECK (impact IN ('low', 'medium', 'high')),
  urgency text NOT NULL DEFAULT 'medium' CHECK (urgency IN ('low', 'medium', 'high')),
  subject text NOT NULL,
  requester_id uuid NOT NULL REFERENCES users(id),
  affected_user_id uuid REFERENCES users(id),
  assignee_id uuid REFERENCES users(id),
  team_id uuid REFERENCES teams(id),
  category_id uuid REFERENCES categories(id),
  sla_policy_id uuid REFERENCES sla_policies(id),
  source text NOT NULL DEFAULT 'portal'
    CHECK (source IN ('portal', 'technician', 'email', 'api', 'phone')),
  tags text[] NOT NULL DEFAULT '{}',
  due_response_at timestamptz,
  due_resolution_at timestamptz,
  first_response_at timestamptz,
  sla_response_breached boolean NOT NULL DEFAULT false,
  sla_resolution_breached boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, number)
);
CREATE INDEX tickets_tenant_status_idx ON tickets (tenant_id, status, created_at DESC);
CREATE INDEX tickets_tenant_assignee_idx ON tickets (tenant_id, assignee_id);
CREATE INDEX tickets_tenant_requester_idx ON tickets (tenant_id, requester_id);

CREATE TABLE ticket_threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id),
  kind text NOT NULL
    CHECK (kind IN ('message', 'internal_note', 'system_event', 'session_record')),
  visibility text NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'internal')),
  body text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_threads_ticket_idx ON ticket_threads (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security (same deny-by-default pattern as 0001)
-- ---------------------------------------------------------------------------

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_teams ON teams
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_categories ON categories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_business_hours ON business_hours
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE sla_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_sla_policies ON sla_policies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_tickets ON tickets
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ticket_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_threads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ticket_threads ON ticket_threads
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
