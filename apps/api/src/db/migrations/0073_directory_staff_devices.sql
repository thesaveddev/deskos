-- ReyDesk schema: directory staff IDs and directory-discovered devices.
--
-- 1. `contacts` gains `staff_id` / `job_title` so directory-synced requesters
--    can be found by employee number (some orgs identify staff by ID rather
--    than email) and so the ticket form can pre-fill richer detail.
-- 2. `devices` gains a `source`/`managed_by`/`directory_object_id` identity so
--    devices discovered from Entra/Intune or on-prem AD computer objects can
--    live alongside agent-enrolled devices. Directory-discovered devices are
--    inventory-only (no agent = no remote control / actions) and are clearly
--    labelled by `source`.

-- ---------------------------------------------------------------------------
-- Contacts: staff/employee ID + job title
-- ---------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS staff_id text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS job_title text;
CREATE INDEX IF NOT EXISTS contacts_staff_idx ON contacts (tenant_id, staff_id);

-- ---------------------------------------------------------------------------
-- Devices: directory discovery identity
-- ---------------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'agent';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS managed_by text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS directory_object_id text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS serial_number text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS manufacturer text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS directory_last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS devices_source_idx ON devices (tenant_id, source);
CREATE UNIQUE INDEX IF NOT EXISTS devices_directory_uq
  ON devices (tenant_id, managed_by, directory_object_id)
  WHERE directory_object_id IS NOT NULL AND managed_by <> '';
