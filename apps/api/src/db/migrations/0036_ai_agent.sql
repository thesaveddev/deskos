-- DeskOS schema: bounded AI Level-1 agent (P4). The agent proposes a
-- remediation from a fixed tool catalog — it never executes autonomously.
-- Every remediation starts `proposed` and requires a human `approved` before
-- its bounded tool runs; everything is audited.

CREATE TABLE ai_remediations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('device_alert', 'posture_alert', 'dex', 'ticket')),
  source_id uuid,
  device_id uuid REFERENCES devices(id) ON DELETE CASCADE,
  tool text NOT NULL
    CHECK (tool IN ('restart_device', 'collect_inventory', 'run_script', 'add_ticket_note', 'set_ticket_priority')),
  tool_args jsonb NOT NULL DEFAULT '{}'::jsonb,
  rationale text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'approved', 'denied', 'executed', 'failed', 'skipped')),
  proposed_by text NOT NULL DEFAULT 'ai',
  approved_by uuid REFERENCES users(id),
  executed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_remediations_tenant_idx ON ai_remediations (tenant_id, status, created_at DESC);
CREATE INDEX ai_remediations_device_idx ON ai_remediations (device_id);

ALTER TABLE ai_remediations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_remediations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_ai_remediations ON ai_remediations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
