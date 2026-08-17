import type { FastifyInstance } from 'fastify'
import { verifyAuditChain } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/reports/tickets',
    { preHandler: [authenticate, requireTenant, requirePermission('report.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      return withTenant(app.db, ctx.tenantId, async (client) => {
        const byStatus = await client.query(
          'SELECT status, count(*)::int AS n FROM tickets GROUP BY status ORDER BY n DESC',
        )
        const byPriority = await client.query(
          'SELECT priority, count(*)::int AS n FROM tickets GROUP BY priority ORDER BY priority',
        )
        const totals = await client.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
             count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
             count(*) FILTER (WHERE sla_response_breached OR sla_resolution_breached)::int AS breached
           FROM tickets`,
        )
        const resolution = await client.query(
          `SELECT
             count(*)::int AS n,
             COALESCE(avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60), 0)::numeric::float8 AS avg_minutes
           FROM tickets WHERE resolved_at IS NOT NULL`,
        )
        const firstResponse = await client.query(
          `SELECT
             count(*)::int AS n,
             COALESCE(avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60), 0)::numeric::float8 AS avg_minutes
           FROM tickets WHERE first_response_at IS NOT NULL`,
        )
        const byAssignee = await client.query(
          `SELECT u.id, u.name,
                  count(*)::int AS open_tickets
             FROM tickets t
             JOIN users u ON u.id = t.assignee_id
            WHERE t.status NOT IN ('resolved','closed')
            GROUP BY u.id, u.name
            ORDER BY open_tickets DESC
            LIMIT 10`,
        )
        const createdDaily = await client.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                  count(*)::int AS n
             FROM tickets
            WHERE created_at > now() - interval '14 days'
            GROUP BY 1 ORDER BY 1`,
        )
        return {
          totals: totals.rows[0],
          byStatus: byStatus.rows,
          byPriority: byPriority.rows,
          resolution: resolution.rows[0],
          firstResponse: firstResponse.rows[0],
          byAssignee: byAssignee.rows,
          createdDaily: createdDaily.rows,
        }
      })
    },
  )

  app.get(
    '/reports/analytics',
    { preHandler: [authenticate, requireTenant, requirePermission('report.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      return withTenant(app.db, ctx.tenantId, async (client) => {
        const sessionTotals = await client.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE state IN ('active','connecting','reconnecting','consent_pending','requested'))::int AS live,
             COALESCE(avg(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)
               FILTER (WHERE ended_at IS NOT NULL), 0)::numeric::float8 AS avg_duration_min
           FROM remote_sessions`,
        )
        const byType = await client.query('SELECT type, count(*)::int AS n FROM remote_sessions GROUP BY type ORDER BY n DESC')
        const byState = await client.query('SELECT state, count(*)::int AS n FROM remote_sessions GROUP BY state ORDER BY n DESC')
        const sessionsPerDay = await client.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
             FROM remote_sessions
            WHERE created_at > now() - interval '30 days'
            GROUP BY 1 ORDER BY 1`,
        )
        const workload = await client.query(
          `SELECT u.id, u.name,
                  count(*) FILTER (WHERE t.status NOT IN ('resolved','closed'))::int AS open,
                  count(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved,
                  COALESCE(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60)
                    FILTER (WHERE t.resolved_at IS NOT NULL), 0)::numeric::float8 AS avg_resolution_min
             FROM tickets t
             LEFT JOIN users u ON u.id = t.assignee_id
            WHERE t.assignee_id IS NOT NULL
            GROUP BY u.id, u.name
            ORDER BY open DESC, resolved DESC
            LIMIT 20`,
        )
        const sla = await client.query(
          `SELECT
             count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
             count(*) FILTER (WHERE status IN ('resolved','closed') AND (sla_response_breached OR sla_resolution_breached))::int AS breached
           FROM tickets`,
        )
        return {
          sessions: { ...sessionTotals.rows[0], byType: byType.rows, byState: byState.rows, perDay: sessionsPerDay.rows },
          workload: workload.rows,
          sla: {
            resolved: sla.rows[0].resolved,
            breached: sla.rows[0].breached,
            complianceRate: sla.rows[0].resolved ? Math.round(((sla.rows[0].resolved - sla.rows[0].breached) / sla.rows[0].resolved) * 1000) / 10 : 100,
          },
        }
      })
    },
  )

  app.get(
    '/reports/compliance',
    { preHandler: [authenticate, requireTenant, requirePermission('audit.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      return withTenant(app.db, ctx.tenantId, async (client) => {
        const integrity = await verifyAuditChain(client, ctx.tenantId)
        const audit = await client.query(
          `SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24h FROM audit_logs`,
        )
        const jit = await client.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status = 'active')::int AS active,
             count(*) FILTER (WHERE status = 'approved')::int AS approved,
             count(*) FILTER (WHERE status = 'revoked')::int AS revoked
           FROM grants`,
        )
        const recordings = await client.query(
          `SELECT
             count(*)::int AS sessions,
             count(*) FILTER (WHERE recording_mode = 'video')::int AS video,
             count(*) FILTER (WHERE recording_mode = 'metadata')::int AS metadata
           FROM remote_sessions`,
        )
        return {
          audit: { ...audit.rows[0], integrityOk: integrity.ok, ...(integrity.brokenAtId ? { brokenAtId: integrity.brokenAtId } : {}) },
          jit: jit.rows[0],
          recordings: recordings.rows[0],
        }
      })
    },
  )
}
