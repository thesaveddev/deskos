import { withTenant, type DbClient, type DbPool } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

interface EscalationPolicyRow {
  id: number
  name: string
  source_status: string
  target_status: string
  trigger_after_minutes: number
  trigger_on_priority: string[]
  target_team_id: string | null
  auto_assign: boolean
}

/** Pick the member to assign on auto-escalation: team lead → first active member. */
async function pickAssignee(client: DbClient, tenantId: string, teamId: string | null): Promise<string | null> {
  if (!teamId) return null
  const lead = await client.query('SELECT lead_id FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, tenantId])
  if (lead.rows[0]?.lead_id) return lead.rows[0].lead_id as string
  const member = await client.query(
    `SELECT tm.user_id FROM team_members tm
      JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1 AND tm.tenant_id = $2 AND u.status = 'active'
     ORDER BY tm.created_at ASC LIMIT 1`,
    [teamId, tenantId],
  )
  return (member.rows[0]?.user_id as string | undefined) ?? null
}

/** Apply one policy to the tickets that have been stuck in its source status long enough. */
async function applyPolicy(client: DbClient, tenantId: string, policy: EscalationPolicyRow): Promise<number> {
  const candidates = await client.query(
    `SELECT t.id, t.number, t.team_id, t.assignee_id, t.priority
       FROM tickets t
      WHERE t.tenant_id = $1
        AND t.status = $2
        AND t.created_at < now() - ($3 * interval '1 minute')
        AND ($4::text[] = '{}' OR t.priority = ANY($4::text[]))
        AND NOT EXISTS (
          SELECT 1 FROM ticket_escalations e
           WHERE e.ticket_id = t.id AND e.reason LIKE 'Auto:%'
        )
      ORDER BY t.created_at ASC
      LIMIT 100`,
    [tenantId, policy.source_status, policy.trigger_after_minutes, policy.trigger_on_priority],
  )

  let applied = 0
  for (const ticket of candidates.rows) {
    const nextTeam = policy.target_team_id ?? ticket.team_id
    const nextAssignee = policy.auto_assign
      ? await pickAssignee(client, tenantId, nextTeam)
      : ticket.assignee_id

    const level = await client.query(
      'SELECT COALESCE(MAX(level), 0) AS max_level FROM ticket_escalations WHERE ticket_id = $1',
      [ticket.id],
    )

    await client.query(
      `INSERT INTO ticket_escalations
         (tenant_id, ticket_id, level, from_team_id, to_team_id, from_assignee_id, to_assignee_id, reason, escalated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)`,
      [
        tenantId, ticket.id, Number(level.rows[0].max_level) + 1,
        ticket.team_id, nextTeam, ticket.assignee_id, nextAssignee,
        `Auto: ${policy.name}`,
      ],
    )

    await client.query(
      `UPDATE tickets
          SET status = $3, team_id = $4, assignee_id = $5, updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [ticket.id, tenantId, policy.target_status, nextTeam, nextAssignee],
    )

    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
       VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
      [tenantId, ticket.id, `Auto-escalated by policy "${policy.name}"`, JSON.stringify({ event: 'ticket.auto_escalated', policyId: policy.id })],
    )

    const notifiee = nextAssignee ?? ticket.assignee_id
    if (notifiee) {
      await notify(client, tenantId, {
        userId: notifiee,
        kind: 'ticket.escalated',
        subjectType: 'ticket',
        subjectId: ticket.id,
        body: `Ticket #${ticket.number} was auto-escalated by "${policy.name}"`,
      })
    }
    applied++
  }
  return applied
}

/** Evaluate all enabled escalation policies for a single tenant inside its RLS context. */
export async function applyAutoEscalationsForTenant(pool: DbPool, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const policies = await client.query(
      'SELECT id, name, source_status, target_status, trigger_after_minutes, trigger_on_priority, target_team_id, auto_assign FROM escalation_policies WHERE enabled = true',
    )
    let total = 0
    for (const policy of policies.rows as EscalationPolicyRow[]) {
      try {
        total += await applyPolicy(client, tenantId, policy)
      } catch {
        /* one faulty policy must not stop the sweep */
      }
    }
    return total
  })
}

/** Sweep every tenant. Tenant discovery uses the global tenants table (no RLS). */
export async function applyAllAutoEscalations(pool: DbPool): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of rows) {
    try {
      total += await applyAutoEscalationsForTenant(pool, tenant.id)
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}

export function startEscalationScheduler(pool: DbPool, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void applyAllAutoEscalations(pool).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return timer
}
