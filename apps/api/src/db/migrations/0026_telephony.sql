-- DeskOS schema: telephony hooks (M5/P2).
-- A provider-agnostic call log that links calls to tickets. CTI/PBX event
-- ingestion and click-to-dial adapters layer on later; this table is the
-- durable control-plane record every adapter writes into.

CREATE TABLE call_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
  from_number text NOT NULL DEFAULT '',
  to_number text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('ringing', 'answered', 'missed', 'completed', 'failed')),
  caller_name text,
  started_at timestamptz NOT NULL DEFAULT now(),
  duration_sec integer NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
  ticket_id uuid REFERENCES tickets(id) ON DELETE SET NULL,
  provider_call_id text,
  recording_ref text,
  ext jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX call_logs_tenant_started_idx ON call_logs (tenant_id, started_at DESC);
CREATE INDEX call_logs_tenant_ticket_idx ON call_logs (tenant_id, ticket_id);
CREATE INDEX call_logs_tenant_from_idx ON call_logs (tenant_id, from_number);
CREATE INDEX call_logs_tenant_to_idx ON call_logs (tenant_id, to_number);
CREATE UNIQUE INDEX call_logs_provider_id_uq ON call_logs (tenant_id, provider_call_id)
  WHERE provider_call_id IS NOT NULL;

ALTER TABLE call_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_call_logs ON call_logs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
