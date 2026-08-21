-- DeskOS schema: note categories and inline note images.
CREATE TABLE note_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT 'gray',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, user_id, name)
);

ALTER TABLE notes ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES note_categories(id) ON DELETE SET NULL;
ALTER TABLE notes ADD COLUMN IF NOT EXISTS image_data text;

CREATE INDEX note_categories_user_idx ON note_categories (tenant_id, user_id, lower(name));
CREATE INDEX notes_category_idx ON notes (tenant_id, user_id, category_id);

ALTER TABLE note_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_note_categories ON note_categories
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
