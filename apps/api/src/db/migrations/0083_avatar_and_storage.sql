-- Profile avatar URL storage.
ALTER TABLE users ADD COLUMN avatar_url text;

-- Track tenant-level storage usage in bytes.
ALTER TABLE tenants ADD COLUMN storage_bytes bigint NOT NULL DEFAULT 0;
