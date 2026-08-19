-- DeskOS schema: bounded AI ticket triage.
-- Triage state is kept in tickets.ext so policy/state changes do not require a
-- second ticket table, while the public conversation remains auditable.

ALTER TABLE ticket_threads DROP CONSTRAINT IF EXISTS ticket_threads_kind_check;
ALTER TABLE ticket_threads ADD CONSTRAINT ticket_threads_kind_check
  CHECK (kind IN ('message', 'internal_note', 'system_event', 'session_record', 'ai_summary', 'ai_triage'));

CREATE INDEX IF NOT EXISTS tickets_ai_triage_status_idx
  ON tickets ((ext->'aiTriage'->>'status'))
  WHERE ext ? 'aiTriage';
