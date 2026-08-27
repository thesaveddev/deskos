CREATE INDEX IF NOT EXISTS audit_logs_agent_update_idx
  ON audit_logs (tenant_id, action, created_at DESC)
  WHERE action LIKE 'agent.update.%';
