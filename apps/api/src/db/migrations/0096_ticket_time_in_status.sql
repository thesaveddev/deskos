-- Time-in-status tracking for escalation policies.
--
-- The auto-escalation sweep matched on ticket AGE (created_at), which means a
-- ticket created 3 hours ago but worked continuously for 2.5 of those hours
-- was treated as "stuck" for the full 3 hours. Storing the last status
-- transition lets policies target how long the ticket has actually been
-- sitting in the source status. A backfill is not needed: rows that predate
-- this column use the NULL fallback (age), preserving current behaviour.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS status_changed_at timestamptz;
CREATE INDEX IF NOT EXISTS tickets_status_changed_idx ON tickets (tenant_id, status, status_changed_at);
