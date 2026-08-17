-- DeskOS schema: billing, subscriptions, and invoices

CREATE TABLE subscription_plans (
  id bigserial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_monthly_cents int NOT NULL DEFAULT 0,
  price_annual_cents int NOT NULL DEFAULT 0,
  max_technicians int NOT NULL DEFAULT 3,
  max_devices int NOT NULL DEFAULT 100,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Seed the three plans
INSERT INTO subscription_plans (slug, name, description, price_monthly_cents, price_annual_cents, max_technicians, max_devices, features) VALUES
  ('free', 'Free', 'For small teams getting started.', 0, 0, 3, 100, '["Remote support","Ticketing with SLA","Knowledge base","1 admin user"]'),
  ('starter', 'Starter', 'For growing IT teams.', 2900, 29000, 10, 500, '["Everything in Free","Up to 10 technicians","500 devices","Endpoint inventory","SLA policies","Audit log"]'),
  ('pro', 'Pro', 'Full ITSM, AI, and RMM for growing teams.', 7900, 79000, -1, 5000, '["Everything in Starter","Unlimited technicians","5000 devices","AI assistant","Automations","Service catalogue","Compliance reporting"]'),
  ('enterprise', 'Enterprise', 'Custom deployment for large organisations.', 0, 0, -1, -1, '["Everything in Pro","Unlimited everything","SAML SSO + SCIM","Custom integrations","Dedicated support","SLA guarantee"]');

CREATE TABLE tenant_subscriptions (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id bigint NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'trialing')),
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL DEFAULT now(),
  current_period_end timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_tenant_sub_active ON tenant_subscriptions(tenant_id) WHERE status IN ('active', 'trialing');

CREATE TABLE invoices (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id bigint REFERENCES tenant_subscriptions(id),
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  amount_cents int NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  description text NOT NULL DEFAULT '',
  due_date timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_invoices_tenant ON invoices(tenant_id, created_at DESC);

CREATE TABLE payment_methods (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type text NOT NULL DEFAULT 'card' CHECK (type IN ('card', 'bank_transfer')),
  brand text NOT NULL DEFAULT '',
  last4 text NOT NULL DEFAULT '',
  exp_month int,
  exp_year int,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_methods_tenant ON payment_methods(tenant_id);

ALTER TABLE tenant_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_subscriptions ON tenant_subscriptions
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_invoices ON invoices
  USING (tenant_id = current_setting('app.tenant_id')::uuid);

ALTER TABLE payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_payment_methods ON payment_methods
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
