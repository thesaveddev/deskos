-- AI worker operations: measurable outcomes, alert-triggered runs, and CMDB context.
ALTER TABLE ai_worker_runs
  ADD COLUMN IF NOT EXISTS trigger_type text NOT NULL DEFAULT 'manual'
    CHECK (trigger_type IN ('manual', 'device_alert', 'ticket')),
  ADD COLUMN IF NOT EXISTS alert_id uuid REFERENCES device_alerts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS escalation_reason text,
  ADD COLUMN IF NOT EXISTS estimated_manual_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS actual_minutes integer,
  ADD COLUMN IF NOT EXISTS resolved_by_worker boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS ai_worker_runs_trigger_idx ON ai_worker_runs (tenant_id, trigger_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_worker_runs_alert_idx ON ai_worker_runs (alert_id) WHERE alert_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS knowledge_graph_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subject_type text NOT NULL CHECK (subject_type IN ('user','device','asset','service','ticket')),
  subject_id uuid NOT NULL,
  relation text NOT NULL CHECK (relation IN ('uses','owns','assigned_to','supports','runs_on','requests','depends_on','located_at')),
  object_type text NOT NULL CHECK (object_type IN ('user','device','asset','service','ticket')),
  object_id uuid NOT NULL,
  confidence numeric(5,4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  source text NOT NULL DEFAULT 'manual',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_type, subject_id, relation, object_type, object_id)
);
CREATE INDEX IF NOT EXISTS knowledge_graph_edges_subject_idx ON knowledge_graph_edges (tenant_id, subject_type, subject_id);
CREATE INDEX IF NOT EXISTS knowledge_graph_edges_object_idx ON knowledge_graph_edges (tenant_id, object_type, object_id);
ALTER TABLE knowledge_graph_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_graph_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_knowledge_graph_edges ON knowledge_graph_edges;
CREATE POLICY tenant_isolation_knowledge_graph_edges ON knowledge_graph_edges
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Default is intentionally off: automatic remediation must be an explicit tenant choice.
