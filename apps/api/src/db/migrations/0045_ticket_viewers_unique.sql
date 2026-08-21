-- This migration name sorts before 0045_ticket_viewing.sql on fresh databases.
-- Apply the index there after the table exists; this guarded step preserves
-- compatibility with databases where ticket_viewers was already created.
DO $$
BEGIN
  IF to_regclass('public.ticket_viewers') IS NOT NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ticket_viewers_tenant_ticket_user
      ON ticket_viewers (tenant_id, ticket_id, user_id);
  END IF;
END
$$;
