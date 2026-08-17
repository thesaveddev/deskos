-- DeskOS schema: recorded remote-session media.
-- The technician console captures the consented WebRTC stream with MediaRecorder
-- and uploads it when the session's recording_mode is 'video'. Files are stored
-- under the managed recordings directory (see config.recordingDir); rows are
-- tenant-scoped and RLS-enforced, and carry an expires_at derived from the
-- session's recording_retention_days so expired media can be purged.

CREATE TABLE session_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES remote_sessions(id) ON DELETE CASCADE,
  recorded_by uuid NOT NULL REFERENCES users(id),
  storage_key text NOT NULL,
  mime text NOT NULL DEFAULT 'video/webm',
  size_bytes bigint NOT NULL,
  duration_sec integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  ended_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_recordings_session_idx ON session_recordings (session_id, created_at DESC);
CREATE INDEX session_recordings_retention_idx ON session_recordings (expires_at) WHERE expires_at IS NOT NULL;

ALTER TABLE session_recordings ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_recordings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_session_recordings ON session_recordings
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
  );
