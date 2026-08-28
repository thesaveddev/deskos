-- ---------------------------------------------------------------------------
-- Fix billing RLS policies that used bare current_setting('app.tenant_id')::uuid.
-- When a tenant has no active subscription, the plan-cap query in the agent
-- enrollment path runs with an unset/empty app.tenant_id, which raised
-- "invalid input syntax for type uuid: ''" and blocked device enrollment.
-- Every other migration guards with NULLIF(..., ''); align these three.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS tenant_isolation_subscriptions ON tenant_subscriptions;
CREATE POLICY tenant_isolation_subscriptions ON tenant_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_invoices ON invoices;
CREATE POLICY tenant_isolation_invoices ON invoices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS tenant_isolation_payment_methods ON payment_methods;
CREATE POLICY tenant_isolation_payment_methods ON payment_methods
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);