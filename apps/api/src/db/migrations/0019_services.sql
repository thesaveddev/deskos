-- DeskOS schema: service catalogue + request approvals.
-- services define requestable catalogue items (with optional approval gate).
-- ticket_approvals track pending/approved/rejected decisions on a ticket.
-- tickets gains service_id to link a service_request back to its catalogue item.

CREATE TABLE services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  sla_policy_id uuid REFERENCES sla_policies(id) ON DELETE SET NULL,
  approval_required boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  form_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_tenant_idx ON services (tenant_id, enabled, category_id);

CREATE TABLE ticket_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  approver_id uuid NOT NULL REFERENCES users(id),
  requested_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_approvals_ticket_idx ON ticket_approvals (ticket_id, status);
CREATE INDEX ticket_approvals_approver_idx ON ticket_approvals (approver_id, status, created_at DESC);

ALTER TABLE tickets ADD COLUMN service_id uuid REFERENCES services(id) ON DELETE SET NULL;
CREATE INDEX tickets_service_idx ON tickets (tenant_id, service_id);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_approvals FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_services ON services
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_ticket_approvals ON ticket_approvals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
