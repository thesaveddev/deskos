-- Platform-level contact messages from the public contact form.
-- Not tenant-scoped: these are sales/support enquiries from people who
-- have no workspace yet, so they belong to the platform operator.

CREATE TABLE IF NOT EXISTS contact_messages (
  id bigserial PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL,
  email text NOT NULL,
  company text,
  subject text NOT NULL CHECK (subject IN ('sales', 'support', 'billing', 'partnership', 'other')),
  message text NOT NULL,
  ip text,
  user_agent text,
  handled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_messages_created_idx ON contact_messages (created_at DESC);

-- Only platform admins read this table. The application layer gates reads
-- behind is_platform_admin; there is no tenant to attach RLS to.
