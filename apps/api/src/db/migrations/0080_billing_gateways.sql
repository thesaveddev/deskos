-- Billing gateway support: Paystack (Africa), Stripe (rest of world), manual.
-- All columns are additive; existing tenants keep their local records.

-- Track which gateway owns a subscription and the client-side subscription id.
ALTER TABLE tenant_subscriptions
  ADD COLUMN gateway text NOT NULL DEFAULT 'manual'
    CHECK (gateway IN ('manual', 'paystack', 'stripe')),
  ADD COLUMN gateway_subscription_id text,
  ADD COLUMN gateway_customer_id text;

-- Expose gateway-originated payment methods (saved authorizations / cards).
ALTER TABLE payment_methods
  ADD COLUMN gateway text NOT NULL DEFAULT 'manual'
    CHECK (gateway IN ('manual', 'paystack', 'stripe')),
  ADD COLUMN gateway_method text,                -- card | bank_transfer | ussd | mobile_money | apple_pay | google_pay
  ADD COLUMN external_id text,                   -- paystack authorization_code / stripe pm_ id
  ADD COLUMN auth_data jsonb;                    -- provider-specific authorization payload

CREATE INDEX idx_payment_methods_gateway ON payment_methods(gateway);

-- Invoice records gateway reference + local currency conversion for reconciliation.
ALTER TABLE invoices
  ADD COLUMN gateway text NOT NULL DEFAULT 'manual',
  ADD COLUMN gateway_reference text,
  ADD COLUMN gateway_external_id text,           -- Stripe session id / provider checkout id
  ADD COLUMN plan_slug text,
  ADD COLUMN billing_cycle text;

CREATE UNIQUE INDEX idx_invoices_gateway_ref ON invoices(gateway_reference) WHERE gateway_reference IS NOT NULL;

-- Pending/paid checkouts are stored as invoices with status 'open' + gateway_reference.
-- A paid checkout flips the invoice to 'paid' and activates/syncs the local subscription.

-- The billing tables were created with FORCE ROW LEVEL SECURITY, which makes
-- any query outside a withTenant() transaction fail on the RLS policy's
-- current_setting('app.tenant_id'). Gateway webhooks (Paystack/Stripe) have no
-- tenant context and must resolve invoices by reference and update
-- subscriptions by gateway id before the tenant is known. The table owner
-- (the API's DB user) bypasses RLS once FORCE is removed, while the policy
-- still applies to any non-owner role. All billing queries still filter by
-- tenant_id explicitly. Same pattern as migration 0057 (ticket_locks).
ALTER TABLE tenant_subscriptions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_methods NO FORCE ROW LEVEL SECURITY;