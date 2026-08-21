-- DeskOS schema: knowledge base rehabilitation.
-- Adds the metadata needed for a useful self-service library without moving
-- article content out of the control-plane database.

ALTER TABLE kb_articles
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  ADD COLUMN IF NOT EXISTS helpful_count integer NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
  ADD COLUMN IF NOT EXISTS not_helpful_count integer NOT NULL DEFAULT 0 CHECK (not_helpful_count >= 0),
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_reviewed_at timestamptz;

ALTER TABLE kb_article_versions
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS kb_articles_review_idx
  ON kb_articles (tenant_id, review_due_at)
  WHERE status = 'published' AND review_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS kb_articles_visibility_idx
  ON kb_articles (tenant_id, visibility, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS kb_articles_search_idx
  ON kb_articles USING GIN (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce(body, '')));

CREATE TABLE IF NOT EXISTS kb_article_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  related_article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'related'
    CHECK (relation_type IN ('related', 'prerequisite', 'follow_up')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (article_id <> related_article_id),
  UNIQUE (article_id, related_article_id, relation_type)
);

CREATE INDEX IF NOT EXISTS kb_article_relations_article_idx
  ON kb_article_relations (article_id, relation_type);
CREATE INDEX IF NOT EXISTS kb_article_relations_related_idx
  ON kb_article_relations (related_article_id);

ALTER TABLE kb_article_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_article_relations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_kb_article_relations ON kb_article_relations;
CREATE POLICY tenant_isolation_kb_article_relations ON kb_article_relations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
