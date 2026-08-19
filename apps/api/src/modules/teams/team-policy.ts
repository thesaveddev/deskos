import { AppError } from '../../core/errors.js'
import type { DbClient, DbPool } from '../../db/pool.js'

/**
 * Validate a ticket destination before any route or automation writes team_id.
 * A null destination means organization-level routing and is allowed.
 */
export async function assertTeamAcceptsTickets(
  client: DbClient | DbPool,
  tenantId: string,
  teamId: string | null | undefined,
): Promise<void> {
  if (!teamId) return
  const result = await client.query(
    'SELECT accepts_tickets FROM teams WHERE id = $1 AND tenant_id = $2',
    [teamId, tenantId],
  )
  const team = result.rows[0]
  if (!team) throw AppError.badRequest('The selected team does not belong to this organization', 'invalid_team')
  if (!team.accepts_tickets) {
    throw AppError.badRequest('This team does not accept tickets. Choose a ticket-enabled team.', 'team_not_accepting_tickets')
  }
}
