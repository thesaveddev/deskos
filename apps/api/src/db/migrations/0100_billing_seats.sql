-- Per-seat billing: subscriptions are now billed per active technician.
-- seats is the quantity snapshot sent to the gateway (Stripe quantity /
-- Paystack plan seat-count), kept in sync with active memberships.

ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS seats int NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seats int;

-- Free-plan seed advertised "1 admin user" while the enforced cap is 3
-- technicians / 100 devices. Align the card copy with the entitlement.
UPDATE subscription_plans
SET features = '["Remote support","Ticketing with SLA","Knowledge base","Up to 3 technicians"]'::jsonb
WHERE slug = 'free' AND features ? '1 admin user';

-- Enterprise seed claimed SAML SSO + SCIM and an SLA guarantee — neither
-- ships. Replace with what Enterprise actually includes.
UPDATE subscription_plans
SET features = (features - 'SAML SSO + SCIM' - 'SLA guarantee') || '["Custom SLA terms"]'::jsonb
WHERE slug = 'enterprise' AND features ? 'SAML SSO + SCIM';
