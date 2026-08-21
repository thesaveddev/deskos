-- Keep child folders when their parent is removed. They become top-level folders.
ALTER TABLE kb_folders
  DROP CONSTRAINT IF EXISTS kb_folders_parent_id_fkey;

ALTER TABLE kb_folders
  ADD CONSTRAINT kb_folders_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES kb_folders(id) ON DELETE SET NULL;
