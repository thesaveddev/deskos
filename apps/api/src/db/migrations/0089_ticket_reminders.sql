-- ---------------------------------------------------------------------------
-- Ticket reminders: technician-set follow-up alarms on a ticket.
-- A reminder fires once when due_at passes; the scheduler marks it fired and
-- notifies the owning user (in-app + push/email per their preferences).
-- ---------------------------------------------------------------------------

CREATE TABLE ticket_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note text NOT NULL DEFAULT '',
  due_at timestamptz NOT NULL,
  fired_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ticket_reminders_due_idx ON ticket_reminders (due_at) WHERE fired_at IS NULL AND dismissed_at IS NULL;
CREATE INDEX ticket_reminders_ticket_idx ON ticket_reminders (tenant_id, ticket_id);

ALTER TABLE ticket_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_reminders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_ticket_reminders ON ticket_reminders
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);