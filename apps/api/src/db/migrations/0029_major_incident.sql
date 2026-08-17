-- DeskOS schema: major incident command centre (P3).
-- A major incident is a ticket (type='major_incident') with command-centre
-- lifecycle fields (severity, status, commander). Bridging reuses ticket_links.

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_type_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
  CHECK (type IN ('incident', 'service_request', 'question', 'problem', 'change', 'major_incident'));

CREATE TABLE major_incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  severity text NOT NULL DEFAULT 'sev3'
    CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4', 'sev5')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'investigating', 'identified', 'mitigated', 'resolved', 'closed')),
  commander_id uuid REFERENCES users(id) ON DELETE SET NULL,
  declared_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX major_incidents_tenant_status_idx ON major_incidents (tenant_id, status, severity);

ALTER TABLE major_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE major_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_major_incidents ON major_incidents
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
