-- DeskOS schema: per-user notification preferences.
-- Each row mutes (enabled=false) or re-channels a specific notification kind
-- for one user. Absence of a row means the default: enabled, in_app channel.
-- notifications gains a channels column recording the routing intent at send time.

ALTER TABLE notifications
  ADD COLUMN channels jsonb NOT NULL DEFAULT '["in_app"]'::jsonb;

CREATE TABLE notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  channels jsonb NOT NULL DEFAULT '["in_app"]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, kind)
);
CREATE INDEX notification_preferences_user_idx ON notification_preferences (tenant_id, user_id);

ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_notification_preferences ON notification_preferences
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
