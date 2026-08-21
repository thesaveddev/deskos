import type { FastifyInstance } from 'fastify'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

/**
 * Requester lookup for ticket creation. Contacts are populated by Entra/AD
 * directory sync (the shared `contacts` table), and can now be matched by
 * name, email, or staff/employee ID — the last of which is how many
 * organisations identify their staff.
 */
export async function directoryRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/directory/search',
    { preHandler: [authenticate, requireTenant, requirePermission('ticket.read')] },
    async (request) => {
      const ctx = request.tenantCtx!
      const q = String((request.query as Record<string, unknown>).q ?? '').trim()
      if (q.length < 2) return { contacts: [] }

      return withTenant(app.db, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id, name, email, phone, department, site, job_title, staff_id, account_status
             FROM contacts
            WHERE name ILIKE $1 OR email ILIKE $1 OR staff_id ILIKE $1
            ORDER BY name
            LIMIT 20`,
          [`%${q}%`],
        )
        return {
          contacts: rows.map((row) => ({
            id: row.id,
            name: row.name,
            email: row.email,
            phone: row.phone ?? null,
            department: row.department ?? null,
            site: row.site ?? null,
            jobTitle: row.job_title ?? null,
            staffId: row.staff_id ?? null,
            accountStatus: row.account_status,
          })),
        }
      })
    },
  )
}
