-- DeskOS schema: enforce tenant isolation for personal sticky notes.
ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_notes ON notes;
CREATE POLICY tenant_isolation_notes ON notes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
