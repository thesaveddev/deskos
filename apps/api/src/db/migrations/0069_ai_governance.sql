-- DeskOS schema: tenant AI governance and usage controls.
-- Provider credentials are encrypted by the API before they reach this table.

ALTER TABLE subscription_plans
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_monthly_requests integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_monthly_tokens integer NOT NULL DEFAULT 0;

UPDATE subscription_plans
   SET ai_enabled = true, ai_monthly_requests = 10000, ai_monthly_tokens = 1000000
 WHERE slug = 'pro';
UPDATE subscription_plans
   SET ai_enabled = true, ai_monthly_requests = -1, ai_monthly_tokens = -1
 WHERE slug = 'enterprise';

CREATE TABLE IF NOT EXISTS tenant_ai_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  provider_mode text NOT NULL DEFAULT 'managed' CHECK (provider_mode IN ('managed', 'byok')),
  provider text NOT NULL DEFAULT 'openai_compatible' CHECK (provider IN ('openai_compatible', 'azure_openai', 'ollama', 'vllm')),
  base_url text,
  model text,
  api_key_enc text,
  model_allowlist jsonb NOT NULL DEFAULT '[]'::jsonb,
  monthly_request_limit integer,
  monthly_token_limit integer,
  retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 7 AND 3650),
  redact_content boolean NOT NULL DEFAULT true,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  updated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_periods (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  token_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period_start)
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id),
  operation text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  success boolean NOT NULL DEFAULT true,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_events_tenant_idx ON ai_usage_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_events_operation_idx ON ai_usage_events (tenant_id, operation, created_at DESC);

ALTER TABLE tenant_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_settings ON tenant_ai_settings;
CREATE POLICY tenant_isolation_ai_settings ON tenant_ai_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ai_usage_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_periods FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_usage_periods ON ai_usage_periods;
CREATE POLICY tenant_isolation_ai_usage_periods ON ai_usage_periods
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ai_usage_events ON ai_usage_events;
CREATE POLICY tenant_isolation_ai_usage_events ON ai_usage_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
