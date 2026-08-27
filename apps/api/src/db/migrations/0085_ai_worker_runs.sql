-- Extend ticket thread kinds so AI workers can post both public resolution
-- messages and internal notes into the ticket timeline.
ALTER TABLE ticket_threads DROP CONSTRAINT IF EXISTS ticket_threads_kind_check;
ALTER TABLE ticket_threads ADD CONSTRAINT ticket_threads_kind_check
  CHECK (kind IN ('message', 'internal_note', 'system_event', 'session_record', 'ai_summary', 'ai_triage', 'ai_worker'));

-- ReyDesk schema: AI worker runs (the "AI worker" layer).
-- A worker run is a governed, resumable execution of a defined ITSM job
-- (e.g. resolve this ticket) against a linked device. Every step is recorded
-- with its risk tier, rationale, approval, result, and timestamps so the
-- whole run is auditable end to end. The worker proposes and (within the
-- tenant's approval policy) executes bounded tools; it never invents tools.

CREATE TABLE IF NOT EXISTS ai_worker_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  worker text NOT NULL DEFAULT 'ticket_worker'
    CHECK (worker IN ('ticket_worker', 'device_worker')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_action', 'resolved', 'handoff', 'failed', 'cancelled')),
  summary text NOT NULL DEFAULT '',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_worker_runs_tenant_idx
  ON ai_worker_runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_worker_runs_ticket_idx
  ON ai_worker_runs (ticket_id) WHERE ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_worker_runs_device_idx
  ON ai_worker_runs (device_id) WHERE device_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_worker_runs_pending_idx
  ON ai_worker_runs (tenant_id) WHERE status IN ('running', 'waiting_approval', 'waiting_action');

ALTER TABLE ai_worker_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_worker_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_worker_runs ON ai_worker_runs;
CREATE POLICY tenant_isolation_ai_worker_runs ON ai_worker_runs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);