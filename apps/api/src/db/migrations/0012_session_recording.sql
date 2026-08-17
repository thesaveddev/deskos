-- DeskOS schema: session recording policy and lifecycle.
-- Metadata recording is always available; video mode is stored and audited here
-- while the actual media capture/forwarding is handled by the media pipeline.
-- Retention is configurable per session and later enforced by a lifecycle worker.

ALTER TABLE remote_sessions
  ADD COLUMN recording_mode text NOT NULL DEFAULT 'metadata'
    CHECK (recording_mode IN ('off', 'metadata', 'video')),
  ADD COLUMN recording_retention_days int NOT NULL DEFAULT 30
    CHECK (recording_retention_days BETWEEN 1 AND 3650);
