-- Knowledge-base review notices: dedupe ledger for overdue-review alerts.
--
-- The review sweep notifies an article's author when a published article
-- passes its review_due_at date. Each (article, due date) notifies once;
-- reviewing the article pushes review_due_at forward, and the next overdue
-- date is a new episode. Article deletion cascades the rows away.
CREATE TABLE kb_review_notices (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  article_id uuid NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  due_date timestamptz NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, article_id, due_date)
);
CREATE INDEX kb_review_notices_tenant_idx ON kb_review_notices (tenant_id, notified_at DESC);

ALTER TABLE kb_review_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_review_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_kb_review_notices ON kb_review_notices
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
