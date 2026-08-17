-- DeskOS schema: problem & change management foundations.
-- ticket_links relate a ticket to another ticket/asset/kb/session (parent/child,
-- related, caused_by, duplicates) — the backbone of problem→incident and
-- change→affected-item relationships.
-- tickets.ext stores problem/change-specific fields (root cause, workaround,
-- risk, plans, schedule) without widening the core table.
-- The ticket type CHECK is widened to admit 'change'.

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ext jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_type_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_type_check
  CHECK (type IN ('incident', 'service_request', 'question', 'problem', 'change'));

CREATE TABLE ticket_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  link_type text NOT NULL
    CHECK (link_type IN ('parent', 'child', 'related', 'caused_by', 'duplicates')),
  target_type text NOT NULL
    CHECK (target_type IN ('ticket', 'asset', 'kb', 'session')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, link_type, target_type, target_id)
);
CREATE INDEX ticket_links_ticket_idx ON ticket_links (ticket_id);
CREATE INDEX ticket_links_target_idx ON ticket_links (target_type, target_id);

ALTER TABLE ticket_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ticket_links ON ticket_links
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
