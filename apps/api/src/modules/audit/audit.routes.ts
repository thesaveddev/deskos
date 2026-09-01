import type { FastifyInstance } from 'fastify'
import { verifyAuditChain } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

interface AuditFilters {
  action?: string
  actorId?: string
  objectType?: string
  from?: string
  to?: string
  before?: string
  limit?: number
}

function whereClause(filters: AuditFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  const push = (sql: string, val: unknown) => {
    params.push(val)
    clauses.push(sql.replace('$P', `$${params.length}`))
  }
  if (filters.action) push(`a.action LIKE $P`, `${filters.action}%`)
  if (filters.actorId) push(`a.actor_id = $P`, filters.actorId)
  if (filters.objectType) push(`a.object_type = $P`, filters.objectType)
  if (filters.from) push(`a.created_at >= $P`, filters.from)
  if (filters.to) push(`a.created_at <= $P`, filters.to)
  if (filters.before) push(`a.id < $P`, filters.before)
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value)
  return `"${s.replace(/"/g, '""')}"`
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const guard = [authenticate, requireTenant, requirePermission('audit.read')]

  app.get('/audit', { preHandler: guard }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as Record<string, string | undefined>
    const filters: AuditFilters = {
      action: query.action,
      actorId: query.actorId,
      objectType: query.objectType,
      from: query.from,
      to: query.to,
      before: query.before,
      limit: Math.min(parseInt(query.limit ?? '100', 10) || 100, 500),
    }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { sql, params } = whereClause(filters)
      const { rows } = await client.query(
        `SELECT a.id, a.actor_type, a.actor_id, u.name AS actor_name, a.action, a.object_type,
                a.object_id, a.ip, a.payload, a.entry_hash, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
           ${sql}
          ORDER BY a.id DESC
          LIMIT ${filters.limit! + 1}`,
        params,
      )
      const hasMore = rows.length > filters.limit!
      const entries = rows.slice(0, filters.limit!)
      return { entries, nextCursor: hasMore ? String(entries[entries.length - 1].id) : null }
    })
  })

  app.get('/audit/verify', { preHandler: guard }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const integrity = await verifyAuditChain(client, ctx.tenantId)
      const { rows } = await client.query('SELECT count(*)::int AS n FROM audit_logs')
      return { ok: integrity.ok, total: rows[0].n, ...(integrity.brokenAtId ? { brokenAtId: integrity.brokenAtId } : {}) }
    })
  })

  app.get('/audit/export.csv', { preHandler: guard }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const query = request.query as Record<string, string | undefined>
    const filters: AuditFilters = {
      action: query.action,
      actorId: query.actorId,
      objectType: query.objectType,
      from: query.from,
      to: query.to,
    }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { sql, params } = whereClause(filters)
      const { rows } = await client.query(
        `SELECT a.id, a.actor_type, a.actor_id, u.name AS actor_name, a.action, a.object_type,
                a.object_id, a.ip, a.payload, a.entry_hash, a.created_at
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_id
           ${sql}
          ORDER BY a.id ASC
          LIMIT 10000`,
        params,
      )
      const header = ['id', 'created_at', 'actor_type', 'actor_id', 'actor_name', 'action', 'object_type', 'object_id', 'ip', 'entry_hash', 'payload']
      const lines = [
        header.map(csvCell).join(','),
        ...rows.map((r: Record<string, unknown>) =>
          header.map((h) => csvCell(h === 'payload' ? JSON.stringify(r.payload) : r[h])).join(','),
        ),
      ]
      reply.header('content-type', 'text/csv; charset=utf-8')
      reply.header('content-disposition', `attachment; filename="reydesk-audit-${Date.now()}.csv"`)
      return lines.join('\n')
    })
  })
}
