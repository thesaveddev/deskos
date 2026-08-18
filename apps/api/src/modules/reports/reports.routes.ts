import type { FastifyInstance } from 'fastify'
import { verifyAuditChain } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

function dateFilter(from?: string, to?: string): { clause: string; params: any[] } {
  const params: any[] = []
  let clause = ''
  if (from) { params.push(from); clause += ` AND created_at >= $${params.length}::timestamptz` }
  if (to) { params.push(to); clause += ` AND created_at <= $${params.length}::timestamptz` }
  return { clause, params }
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  /* ─── Executive Overview ─── */
  app.get(
    '/reports/overview',
    { preHandler: [authenticate, requireTenant, requirePermission('report.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const q = (request.query as any)
      const { clause, params } = dateFilter(q.from, q.to)

      return withTenant(app.db, ctx.tenantId, async (client) => {
        const totals = await client.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS open,
             count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
             count(*) FILTER (WHERE status = 'new')::int AS new_count,
             count(*) FILTER (WHERE status = 'escalated')::int AS escalated,
             count(*) FILTER (WHERE sla_response_breached OR sla_resolution_breached)::int AS breached
           FROM tickets WHERE 1=1${clause}`, params,
        )

        const resolution = await client.query(
          `SELECT
             count(*)::int AS n,
             COALESCE(avg(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60), 0)::numeric::float8 AS avg_minutes,
             COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)
               FILTER (WHERE resolved_at IS NOT NULL), 0)::numeric::float8 AS median_minutes,
             COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60)
               FILTER (WHERE resolved_at IS NOT NULL), 0)::numeric::float8 AS p95_minutes
           FROM tickets WHERE resolved_at IS NOT NULL${clause}`, params,
        )

        const firstResponse = await client.query(
          `SELECT
             count(*)::int AS n,
             COALESCE(avg(EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60), 0)::numeric::float8 AS avg_minutes,
             COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (first_response_at - created_at)) / 60)
               FILTER (WHERE first_response_at IS NOT NULL), 0)::numeric::float8 AS median_minutes
           FROM tickets WHERE first_response_at IS NOT NULL${clause}`, params,
        )

        const sla = await client.query(
          `SELECT
             count(*) FILTER (WHERE status IN ('resolved','closed'))::int AS resolved,
             count(*) FILTER (WHERE status IN ('resolved','closed') AND sla_response_breached)::int AS response_breached,
             count(*) FILTER (WHERE status IN ('resolved','closed') AND sla_resolution_breached)::int AS resolution_breached
           FROM tickets WHERE 1=1${clause}`, params,
        )

        const byStatus = await client.query(
          `SELECT status, count(*)::int AS n FROM tickets WHERE 1=1${clause} GROUP BY status ORDER BY n DESC`,
          params,
        )

        const byPriority = await client.query(
          `SELECT priority, count(*)::int AS n FROM tickets WHERE 1=1${clause} GROUP BY priority ORDER BY priority`,
          params,
        )

        const byType = await client.query(
          `SELECT type, count(*)::int AS n FROM tickets WHERE 1=1${clause} GROUP BY type ORDER BY n DESC`,
          params,
        )

        const bySource = await client.query(
          `SELECT source, count(*)::int AS n FROM tickets WHERE 1=1${clause} GROUP BY source ORDER BY n DESC`,
          params,
        )

        const byCategory = await client.query(
          `SELECT COALESCE(c.name, 'Uncategorized') AS category, count(*)::int AS n
           FROM tickets t LEFT JOIN categories c ON c.id = t.category_id
           WHERE 1=1${clause} GROUP BY c.name ORDER BY n DESC LIMIT 10`,
          params,
        )

        const byTeam = await client.query(
          `SELECT COALESCE(tm.name, 'Unassigned') AS team, count(*)::int AS n
           FROM tickets t LEFT JOIN teams tm ON tm.id = t.team_id
           WHERE 1=1${clause} GROUP BY tm.name ORDER BY n DESC LIMIT 10`,
          params,
        )

        const hourly = await client.query(
          `SELECT EXTRACT(HOUR FROM created_at)::int AS hour, count(*)::int AS n
           FROM tickets WHERE 1=1${clause} GROUP BY 1 ORDER BY 1`,
          params,
        )

        const daily = await client.query(
          `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, count(*)::int AS n
           FROM tickets WHERE created_at > now() - interval '90 days'${clause}
           GROUP BY 1 ORDER BY 1`,
          params,
        )

        const byAssignee = await client.query(
          `SELECT u.id, u.name,
                  count(*)::int AS total,
                  count(*) FILTER (WHERE t.status NOT IN ('resolved','closed'))::int AS open,
                  count(*) FILTER (WHERE t.status IN ('resolved','closed'))::int AS resolved,
                  COALESCE(avg(EXTRACT(EPOCH FROM (t.resolved_at - t.created_at)) / 60)
                    FILTER (WHERE t.resolved_at IS NOT NULL), 0)::numeric::float8 AS avg_resolution_min,
                  COALESCE(avg(EXTRACT(EPOCH FROM (t.first_response_at - t.created_at)) / 60)
                    FILTER (WHERE t.first_response_at IS NOT NULL), 0)::numeric::float8 AS avg_response_min
           FROM tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           WHERE t.assignee_id IS NOT NULL${clause}
           GROUP BY u.id, u.name
           ORDER BY total DESC
           LIMIT 20`,
          params,
        )

        const sessions = await client.query(
          `SELECT
             count(*)::int AS total,
             count(*) FILTER (WHERE state IN ('active','connecting','reconnecting'))::int AS live,
             COALESCE(avg(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)
               FILTER (WHERE ended_at IS NOT NULL), 0)::numeric::float8 AS avg_duration_min
           FROM remote_sessions`,
        )

        const auditTotal = await client.query(
          `SELECT count(*)::int AS total FROM audit_logs`,
        )

        const slaRate = sla.rows[0].resolved
          ? Math.round(((sla.rows[0].resolved - sla.rows[0].response_breached - sla.rows[0].resolution_breached) / sla.rows[0].resolved) * 1000) / 10
          : 100

        return {
          totals: totals.rows[0],
          resolution: resolution.rows[0],
          firstResponse: firstResponse.rows[0],
          sla: { ...sla.rows[0], complianceRate: slaRate },
          byStatus: byStatus.rows,
          byPriority: byPriority.rows,
          byType: byType.rows,
          bySource: bySource.rows,
          byCategory: byCategory.rows,
          byTeam: byTeam.rows,
          hourly: hourly.rows,
          daily: daily.rows,
          byAssignee: byAssignee.rows,
          sessions: sessions.rows[0],
          auditTotal: auditTotal.rows[0].total,
        }
      })
    },
  )

  /* ─── Ticket Detail Report ─── */
  app.get(
    '/reports/tickets',
    { preHandler: [authenticate, requireTenant, requirePermission('report.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const q = (request.query as any)
      const { clause, params } = dateFilter(q.from, q.to)

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

  /* ─── Analytics ─── */
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

  /* ─── Compliance ─── */
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

  /* ─── Export: Ticket CSV ─── */
  app.get(
    '/reports/export/tickets',
    { preHandler: [authenticate, requireTenant, requirePermission('report.read')] },
    async (request, reply) => {
      const ctx = request.tenantCtx!
      const q = (request.query as any)
      const { clause, params } = dateFilter(q.from, q.to)

      return withTenant(app.db, ctx.tenantId, async (client) => {
        const rows = await client.query(
          `SELECT t.number, t.subject, t.status, t.priority, t.type, t.source, t.impact, t.urgency,
                  t.created_at, t.first_response_at, t.resolved_at, t.closed_at,
                  t.sla_response_breached, t.sla_resolution_breached,
                  u1.name AS requester, u2.name AS assignee, tm.name AS team, c.name AS category
           FROM tickets t
           LEFT JOIN users u1 ON u1.id = t.requester_id
           LEFT JOIN users u2 ON u2.id = t.assignee_id
           LEFT JOIN teams tm ON tm.id = t.team_id
           LEFT JOIN categories c ON c.id = t.category_id
           WHERE 1=1${clause}
           ORDER BY t.created_at DESC`, params,
        )

        const header = 'Number,Subject,Status,Priority,Type,Source,Impact,Urgency,Created,First Response,Resolved,Closed,SLA Response Breached,SLA Resolution Breached,Requester,Assignee,Team,Category'
        const csv = [header, ...rows.rows.map((r: any) =>
          [
            r.number,
            `"${(r.subject ?? '').replace(/"/g, '""')}"`,
            r.status, r.priority, r.type, r.source, r.impact, r.urgency,
            r.created_at?.toISOString?.() ?? '',
            r.first_response_at?.toISOString?.() ?? '',
            r.resolved_at?.toISOString?.() ?? '',
            r.closed_at?.toISOString?.() ?? '',
            r.sla_response_breached, r.sla_resolution_breached,
            r.requester ?? '', r.assignee ?? '', r.team ?? '', r.category ?? '',
          ].join(','),
        )].join('\n')

        reply.header('Content-Type', 'text/csv')
        reply.header('Content-Disposition', `attachment; filename="deskos-tickets-${new Date().toISOString().slice(0, 10)}.csv"`)
        return reply.send(csv)
      })
    },
  )
}
