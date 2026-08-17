-- DeskOS schema: AI assistant (M5/P2). No new tables: AI output lands in the
-- existing ticket_threads (ai_summary kind) and kb_articles (draft status).
-- Similar-incident detection is computed on demand with a token-overlap
-- heuristic, so no vector extension is required.

ALTER TABLE ticket_threads DROP CONSTRAINT IF EXISTS ticket_threads_kind_check;
ALTER TABLE ticket_threads ADD CONSTRAINT ticket_threads_kind_check
  CHECK (kind IN ('message', 'internal_note', 'system_event', 'session_record', 'ai_summary'));
