-- Per-asset expiry-email mute.
--
-- The tenant setting (assets.warranty_expiry_emails) turns expiry notices off
-- for everyone; this column lets an asset owner or IT admin silence the
-- notices for a single asset (e.g. an appliance whose warranty will never be
-- renewed but which must stay in the inventory). The expiry sweep skips
-- muted assets entirely, so no in-app notification fires either.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS expiry_emails_muted boolean NOT NULL DEFAULT false;
