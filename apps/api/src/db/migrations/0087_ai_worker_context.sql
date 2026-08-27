-- Alert-triggered workers are opt-in and remain governed by the existing worker policy.
-- Knowledge graph edges are populated by the CMDB and ticket linking workflows.
CREATE INDEX IF NOT EXISTS knowledge_graph_edges_relation_idx
  ON knowledge_graph_edges (tenant_id, relation, created_at DESC);
