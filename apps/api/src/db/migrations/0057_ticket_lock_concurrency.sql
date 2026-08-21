-- DeskOS schema: one lock owner per ticket.
-- Older releases enforced this only in application code and could create
-- multiple locks during concurrent claim requests.

-- 0044 intentionally forced RLS for runtime access. Migrations run before a
-- tenant context exists, so briefly let the table owner consolidate legacy
-- rows, then restore the runtime policy.
ALTER TABLE ticket_locks NO FORCE ROW LEVEL SECURITY;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY ticket_id
           ORDER BY (expires_at > now()) DESC, heartbeat_at DESC, id DESC
         ) AS rn
    FROM ticket_locks
)
DELETE FROM ticket_locks l
 USING ranked r
 WHERE l.id = r.id
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_locks_ticket
  ON ticket_locks (ticket_id);

ALTER TABLE ticket_locks FORCE ROW LEVEL SECURITY;
