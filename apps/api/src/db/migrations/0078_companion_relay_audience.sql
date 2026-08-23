-- Browser companions join the relay for chat and consent status only.
-- They must not be treated as a second screen publisher.

ALTER TABLE session_join_tokens
  DROP CONSTRAINT IF EXISTS session_join_tokens_audience_check;

ALTER TABLE session_join_tokens
  ADD CONSTRAINT session_join_tokens_audience_check
  CHECK (audience IN ('technician', 'agent', 'companion'));
