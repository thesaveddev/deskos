-- ReyDesk notes: support multiple inline images per note.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Fold any legacy single image (image_data) into the new array exactly once.
-- The images = '[]' guard keeps this idempotent if the migration is re-applied.
UPDATE notes
   SET images = jsonb_build_array(image_data)
 WHERE image_data IS NOT NULL
   AND image_data <> ''
   AND images = '[]'::jsonb;
