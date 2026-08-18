-- Add unique constraint for ON CONFLICT upsert on ticket_viewers
CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_viewers_tenant_ticket_user
  ON ticket_viewers (tenant_id, ticket_id, user_id);
