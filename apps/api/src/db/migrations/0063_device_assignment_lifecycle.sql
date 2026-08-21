-- DeskOS schema: device ownership, assignment history, and asset identity.
-- The assignment table was introduced by DEX. This migration turns it into a
-- complete IT asset lifecycle record without breaking existing DEX assignments.

ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS assigned_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS returned_at timestamptz;
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS expected_return_at timestamptz;
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '';
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS assignment_status text NOT NULL DEFAULT 'assigned';
ALTER TABLE device_assignments ADD COLUMN IF NOT EXISTS audit_event text;

UPDATE device_assignments
   SET assignment_status = CASE WHEN user_id IS NULL THEN 'shared' ELSE 'assigned' END
 WHERE assignment_status = 'assigned';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'device_assignments_status_check'
       AND conrelid = 'device_assignments'::regclass
  ) THEN
    ALTER TABLE device_assignments
      ADD CONSTRAINT device_assignments_status_check
      CHECK (assignment_status IN ('assigned', 'shared', 'temporary', 'returned'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS device_assignments_user_history_idx
  ON device_assignments (tenant_id, user_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS device_assignments_expected_return_idx
  ON device_assignments (tenant_id, expected_return_at)
  WHERE ended_at IS NULL;

-- `assets.tag` is the human-facing asset tag. It is deliberately separate from
-- hostnames, serial numbers, and DeskOS UUIDs, and may not be renamed after
-- creation. QR payloads are opaque identity values, not secrets.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS qr_payload text;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS barcode_value text;

UPDATE assets
   SET qr_payload = COALESCE(qr_payload, 'deskos://asset/' || tenant_id::text || '/' || tag),
       barcode_value = COALESCE(barcode_value, tag);

CREATE OR REPLACE FUNCTION prevent_asset_tag_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.tag IS DISTINCT FROM NEW.tag THEN
    RAISE EXCEPTION 'Asset tags are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS assets_tag_immutable ON assets;
CREATE TRIGGER assets_tag_immutable
  BEFORE UPDATE OF tag ON assets
  FOR EACH ROW EXECUTE FUNCTION prevent_asset_tag_change();

CREATE INDEX IF NOT EXISTS assets_barcode_idx ON assets (tenant_id, barcode_value);
