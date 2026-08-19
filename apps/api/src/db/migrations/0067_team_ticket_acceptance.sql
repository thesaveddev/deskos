-- DeskOS schema: team ticket acceptance policy.
-- Existing teams remain ticket-enabled for backwards compatibility.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS accepts_tickets boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN teams.accepts_tickets IS
  'Whether new, assigned, escalated, forwarded, or automated tickets may be routed to this team';
