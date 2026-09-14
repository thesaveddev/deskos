-- ---------------------------------------------------------------------------
-- Migration 0091: AI Playbooks, Governance, Cost Tracking, and Usage Alerts
-- ---------------------------------------------------------------------------

-- Pre-built L1 playbooks for common helpdesk requests
CREATE TABLE IF NOT EXISTS ai_playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'password_reset', 'software_install', 'printer', 'network', 'account_unlock', 'email', 'hardware', 'security', 'custom')),
  trigger_keywords text[] NOT NULL DEFAULT '{}',
  system_prompt text NOT NULL,
  max_steps int NOT NULL DEFAULT 6,
  auto_approve_low_risk boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  usage_count int NOT NULL DEFAULT 0,
  success_rate float8 NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_playbooks_tenant_idx ON ai_playbooks (tenant_id, enabled);
ALTER TABLE ai_playbooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_playbooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_playbooks ON ai_playbooks;
CREATE POLICY tenant_isolation_ai_playbooks ON ai_playbooks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- AI activity log for governance dashboard
CREATE TABLE IF NOT EXISTS ai_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_type text NOT NULL DEFAULT 'worker'
    CHECK (actor_type IN ('worker', 'triage', 'agent', 'external_client', 'system')),
  actor_id text,
  action text NOT NULL,
  tool_name text,
  resource_type text,
  resource_id text,
  data_accessed jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  duration_ms int NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  error_message text,
  ip_address text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_activity_log_tenant_idx ON ai_activity_log (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_activity_log_action_idx ON ai_activity_log (tenant_id, action, created_at DESC);
ALTER TABLE ai_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_activity_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_activity_log ON ai_activity_log;
CREATE POLICY tenant_isolation_ai_activity_log ON ai_activity_log
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Per-tool permission matrix
CREATE TABLE IF NOT EXISTS ai_tool_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT false,
  max_uses_per_hour int NOT NULL DEFAULT 50,
  allowed_roles text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id, tool_name)
);

ALTER TABLE ai_tool_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tool_permissions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_tool_permissions ON ai_tool_permissions;
CREATE POLICY tenant_isolation_ai_tool_permissions ON ai_tool_permissions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Cost tracking per worker run
ALTER TABLE ai_worker_runs ADD COLUMN IF NOT EXISTS input_tokens int NOT NULL DEFAULT 0;
ALTER TABLE ai_worker_runs ADD COLUMN IF NOT EXISTS output_tokens int NOT NULL DEFAULT 0;
ALTER TABLE ai_worker_runs ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(10,6) NOT NULL DEFAULT 0;
ALTER TABLE ai_worker_runs ADD COLUMN IF NOT EXISTS playbook_id uuid REFERENCES ai_playbooks(id) ON DELETE SET NULL;
ALTER TABLE ai_worker_runs ADD COLUMN IF NOT EXISTS confidence_score float8;

-- Usage alerts
CREATE TABLE IF NOT EXISTS ai_usage_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alert_type text NOT NULL
    CHECK (alert_type IN ('request_threshold', 'token_threshold', 'cost_threshold', 'failure_rate')),
  threshold_value numeric(10,4) NOT NULL,
  current_value numeric(10,4) NOT NULL DEFAULT 0,
  notified boolean NOT NULL DEFAULT false,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_alerts_tenant_idx ON ai_usage_alerts (tenant_id, notified);
ALTER TABLE ai_usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_alerts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_usage_alerts ON ai_usage_alerts;
CREATE POLICY tenant_isolation_ai_usage_alerts ON ai_usage_alerts
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
