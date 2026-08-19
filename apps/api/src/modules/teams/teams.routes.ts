import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const teamSchema = z.object({
  name: z.string().min(2).max(100),
  acceptsTickets: z.boolean().default(true),
})

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.get('/teams', { preHandler: [...guards, requirePermission('member.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const teams = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT t.*, u.name AS lead_name
             FROM teams t
             LEFT JOIN users u ON u.id = t.lead_id
            ORDER BY t.name`,
        )
        .then((r) => r.rows),
    )
    return { teams }
  })

  app.post('/teams', { preHandler: [...guards, requirePermission('member.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = teamSchema.parse(request.body)
    try {
      const team = await withTenant(app.db, ctx.tenantId, (client) =>
        client.query('INSERT INTO teams (tenant_id, name, accepts_tickets) VALUES ($1, $2, $3) RETURNING *', [ctx.tenantId, body.name, body.acceptsTickets]),
      )
      return reply.code(201).send({ team: team.rows[0] })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw AppError.conflict('A team with this name already exists', 'team_name_taken')
      }
      throw err
    }
  })
}

export async function searchRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/search',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const q = String((request.query as Record<string, unknown>).q ?? '').trim()
      if (q.length < 2) return { tickets: [], users: [] }

      return withTenant(app.db, ctx.tenantId, async (client) => {
        const tickets = await client.query(
          `SELECT id, number, subject, status, priority
             FROM tickets
            WHERE subject ILIKE $1 OR number::text = $2
            ORDER BY created_at DESC
            LIMIT 10`,
          [`%${q}%`, q.replace(/^#/, '')],
        )
        const users = await client.query(
          `SELECT u.id, u.name, u.email, m.org_role
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = $1 AND (u.name ILIKE $2 OR u.email ILIKE $2)
            ORDER BY u.name
            LIMIT 10`,
          [ctx.tenantId, `%${q}%`],
        )
        return { tickets: tickets.rows, users: users.rows }
      })
    },
  )
}
