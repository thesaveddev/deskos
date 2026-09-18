import type { FastifyInstance } from 'fastify'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

export async function registerSessionHistoryRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  /**
   * Session audit history for a ticket: every remote session linked to the
   * ticket plus the recent audit events of each. Sessions belong to the
   * requesting tenant through RLS; events are limited to a per-session window
   * so a long-lived session cannot flood the panel.
   */
  app.get('/tickets/:id/sessions', { preHandler: [...guards, requirePermission('ticket.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { id: ticketId } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const exists = await client.query('SELECT id FROM tickets WHERE id = $1', [ticketId])
      if (!exists.rows[0]) throw Object.assign(new Error('Ticket not found'), { statusCode: 404 })

      const sessions = await client.query(
        `SELECT s.id, s.type, s.state, s.reason, s.permissions,
                s.consented_at, s.started_at, s.ended_at, s.created_at,
                d.name AS device_name, d.hostname,
                u.name AS requested_by_name,
                (SELECT count(*)::int FROM session_events e WHERE e.session_id = s.id) AS event_count
           FROM remote_sessions s
           JOIN devices d ON d.id = s.device_id
           LEFT JOIN users u ON u.id = s.requested_by
          WHERE s.ticket_id = $1
          ORDER BY s.created_at DESC
          LIMIT 20`,
        [ticketId],
      )

      const sessionIds = sessions.rows.map((row: { id: string }) => row.id)
      let events: Array<{
        id: number
        session_id: string
        actor_type: string
        event: string
        payload: Record<string, unknown>
        created_at: string
      }> = []
      if (sessionIds.length > 0) {
        const eventRows = await client.query(
          `SELECT e.id, e.session_id, e.actor_type, e.event, e.payload, e.created_at
             FROM session_events e
            WHERE e.session_id = ANY($1::uuid[])
            ORDER BY e.created_at DESC
            LIMIT 120`,
          [sessionIds],
        )
        events = eventRows.rows
      }

      return { sessions: sessions.rows, events }
    })
  })
}
