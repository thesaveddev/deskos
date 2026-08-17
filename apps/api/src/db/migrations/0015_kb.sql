-- DeskOS schema: knowledge base.
-- Articles support rich text, folders, internal/portal/public visibility,
-- a draft→review→published→archived lifecycle, integer versioning with full
-- history in kb_article_versions, and user feedback. All tables are
-- tenant-scoped and RLS-enforced.

CREATE TABLE kb_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  parent_id uuid REFERENCES kb_folders(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'portal', 'public')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_folders_tenant_idx ON kb_folders (tenant_id, parent_id);

CREATE TABLE kb_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES kb_folders(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  visibility text NOT NULL DEFAULT 'internal'
    CHECK (visibility IN ('internal', 'portal', 'public')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'review', 'published', 'archived')),
  author_id uuid NOT NULL REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  tags text[] NOT NULL DEFAULT '{}',
  review_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_articles_tenant_idx ON kb_articles (tenant_id, status, created_at DESC);
CREATE INDEX kb_articles_folder_idx ON kb_articles (tenant_id, folder_id);
CREATE INDEX kb_articles_tags_idx ON kb_articles USING GIN (tags);

CREATE TABLE kb_article_versions (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (article_id, version)
);
CREATE INDEX kb_article_versions_article_idx ON kb_article_versions (article_id, version DESC);

CREATE TABLE kb_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  helpful boolean,
  comment text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX kb_feedback_article_idx ON kb_feedback (article_id, created_at DESC);

ALTER TABLE kb_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_folders FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_articles FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_article_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE kb_feedback FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_kb_folders ON kb_folders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_kb_articles ON kb_articles
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_kb_versions ON kb_article_versions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_kb_feedback ON kb_feedback
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
