-- DeskOS schema: Web Push subscriptions (P4 mobile support). A technician can
-- register one or more browser/device subscriptions per tenant; the notify()
-- pipeline then dispatches push messages fire-and-forget for kinds the user
-- receives in-app. Subscriber p256dh/auth keys are encrypted at rest.

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  -- Subscriber-specific secrets (AES-256-GCM encrypted, never returned).
  p256dh_enc text NOT NULL,
  auth_enc text NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX push_subscriptions_user_endpoint_uq ON push_subscriptions (user_id, endpoint);
CREATE INDEX push_subscriptions_tenant_idx ON push_subscriptions (tenant_id, user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_push_subscriptions ON push_subscriptions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
