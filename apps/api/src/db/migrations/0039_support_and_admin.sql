-- DeskOS schema: support tickets (product issues) and platform admin flag.
-- support_tickets are NOT tenant-scoped — they are platform-level tickets
-- for issues with DeskOS itself, raised by any authenticated user.

CREATE TABLE support_tickets (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE SET NULL,
  number serial,
  subject text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'bug', 'feature_request', 'billing', 'security', 'other')),
  priority text NOT NULL DEFAULT 'p3' CHECK (priority IN ('p1', 'p2', 'p3', 'p4')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting_user', 'resolved', 'closed')),
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_tickets_user ON support_tickets(user_id);
CREATE INDEX idx_support_tickets_status ON support_tickets(status);
CREATE INDEX idx_support_tickets_number ON support_tickets(number);

-- Support ticket threads (messages on a support ticket)
CREATE TABLE support_ticket_threads (
  id bigserial PRIMARY KEY,
  support_ticket_id bigint NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'internal_note', 'system_event')),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_support_ticket_threads_ticket ON support_ticket_threads(support_ticket_id);

-- Add platform_admin flag to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin boolean NOT NULL DEFAULT false;
