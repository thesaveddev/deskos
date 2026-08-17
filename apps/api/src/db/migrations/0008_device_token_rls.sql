-- DeskOS schema: allow pre-tenant device-token authentication through RLS.
-- The token hash is supplied only as a LOCAL transaction setting by the API.
-- Agent writes still require app.tenant_id through WITH CHECK.

DROP POLICY tenant_isolation_devices ON devices;
CREATE POLICY tenant_isolation_devices ON devices
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR agent_token_hash = NULLIF(current_setting('app.device_token_hash', true), '')
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
