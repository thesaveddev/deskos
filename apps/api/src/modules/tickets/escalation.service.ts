import type { DbClient, DbPool } from '../../db/pool.js'
import { assertTeamAcceptsTickets } from '../teams/team-policy.js'

/* ── Escalation ──────────────────────────────────────────────── */

export interface EscalationPolicy {
  id: number
  tenant_id: string
  name: string
  description: string
  source_status: string
  target_status: string
  trigger_after_minutes: number
  trigger_on_priority: string[]
  target_team_id: string | null
  target_role: string | null
  auto_assign: boolean
  enabled: boolean
  created_at: string
}

export interface TicketEscalation {
  id: number
  ticket_id: string
  level: number
  from_team_id: string | null
  to_team_id: string | null
  from_assignee_id: string | null
  to_assignee_id: string | null
  reason: string
  escalated_by: string | null
  escalated_by_name?: string
  created_at: string
}

export async function listEscalationPolicies(db: DbClient | DbPool, tenantId: string): Promise<EscalationPolicy[]> {
  const { rows } = await db.query(
    `SELECT * FROM escalation_policies WHERE tenant_id = $1 ORDER BY trigger_after_minutes ASC`,
    [tenantId],
  )
  return rows
}

export async function createEscalationPolicy(
  db: DbClient | DbPool,
  tenantId: string,
  data: Partial<EscalationPolicy>,
): Promise<EscalationPolicy> {
  const { rows } = await db.query(
    `INSERT INTO escalation_policies (tenant_id, name, description, source_status, target_status,
       trigger_after_minutes, trigger_on_priority, target_team_id, target_role, auto_assign)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      tenantId,
      data.name || 'Untitled',
      data.description || '',
      data.source_status || 'open',
      data.target_status || 'escalated',
      data.trigger_after_minutes ?? 60,
      data.trigger_on_priority || [],
      data.target_team_id || null,
      data.target_role || null,
      data.auto_assign ?? false,
    ],
  )
  return rows[0]
}

export async function updateEscalationPolicy(
  db: DbClient | DbPool,
  tenantId: string,
  policyId: number,
  data: Partial<EscalationPolicy>,
): Promise<EscalationPolicy | null> {
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 3
  for (const [key, val] of Object.entries(data)) {
    if (val === undefined || key === 'id' || key === 'tenant_id') continue
    fields.push(`${key} = $${idx}`)
    values.push(val)
    idx++
  }
  if (fields.length === 0) return null
  const { rows } = await db.query(
    `UPDATE escalation_policies SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [policyId, tenantId, ...values],
  )
  return rows[0] ?? null
}

export async function deleteEscalationPolicy(db: DbClient | DbPool, tenantId: string, policyId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM escalation_policies WHERE id = $1 AND tenant_id = $2',
    [policyId, tenantId],
  )
  return (rowCount ?? 0) > 0
}

/* ── Escalate a ticket ───────────────────────────────────────── */

export async function escalateTicket(
  db: DbClient | DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
  data: { to_team_id?: string; to_assignee_id?: string; reason: string },
): Promise<TicketEscalation> {
  // Get current ticket state
  const { rows: ticketRows } = await db.query(
    'SELECT team_id, assignee_id FROM tickets WHERE id = $1 AND tenant_id = $2',
    [ticketId, tenantId],
  )
  if (!ticketRows[0]) throw new Error('Ticket not found')
  const ticket = ticketRows[0]

  // Get current escalation level
  const { rows: escRows } = await db.query(
    'SELECT COALESCE(MAX(level), 0) AS max_level FROM ticket_escalations WHERE ticket_id = $1',
    [ticketId],
  )
  const level = (escRows[0]?.max_level || 0) + 1

  // Update ticket
  const newTeam = data.to_team_id ?? null
  const newAssignee = data.to_assignee_id ?? null
  await assertTeamAcceptsTickets(db, tenantId, data.to_team_id)
  await db.query(
    `UPDATE tickets SET team_id = COALESCE($3, team_id), assignee_id = COALESCE($4, assignee_id),
     status = 'escalated', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [ticketId, tenantId, newTeam, newAssignee],
  )

  // Record escalation
  const { rows } = await db.query(
    `INSERT INTO ticket_escalations (tenant_id, ticket_id, level, from_team_id, to_team_id,
       from_assignee_id, to_assignee_id, reason, escalated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenantId, ticketId, level, ticket.team_id, newTeam, ticket.assignee_id, newAssignee, data.reason, userId],
  )

  // Log activity
  await logActivity(db, tenantId, ticketId, userId, 'escalated', {
    level, from_team: ticket.team_id, to_team: newTeam, reason: data.reason,
  })

  return rows[0]
}

export async function getTicketEscalations(db: DbClient | DbPool, tenantId: string, ticketId: string): Promise<TicketEscalation[]> {
  const { rows } = await db.query(
    `SELECT e.*, u.name AS escalated_by_name
     FROM ticket_escalations e
     LEFT JOIN users u ON u.id = e.escalated_by
     WHERE e.tenant_id = $1 AND e.ticket_id = $2
     ORDER BY e.created_at DESC`,
    [tenantId, ticketId],
  )
  return rows
}

/* ── Forward / Transfer ──────────────────────────────────────── */

export async function forwardTicket(
  db: DbClient | DbPool,
  tenantId: string,
  ticketId: string,
  userId: string,
  data: { to_team_id?: string; to_assignee_id?: string; note?: string },
): Promise<void> {
  const { rows: ticketRows } = await db.query(
    'SELECT team_id, assignee_id FROM tickets WHERE id = $1 AND tenant_id = $2',
    [ticketId, tenantId],
  )
  if (!ticketRows[0]) throw new Error('Ticket not found')
  const ticket = ticketRows[0]

  const newTeam = data.to_team_id ?? ticket.team_id
  const newAssignee = data.to_assignee_id ?? null
  if (data.to_team_id !== undefined) await assertTeamAcceptsTickets(db, tenantId, data.to_team_id)

  await db.query(
    `UPDATE tickets SET team_id = $3, assignee_id = $4, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [ticketId, tenantId, newTeam, newAssignee],
  )

  await logActivity(db, tenantId, ticketId, userId, 'forwarded', {
    from_team: ticket.team_id, to_team: newTeam, from_assignee: ticket.assignee_id, to_assignee: newAssignee,
    note: data.note || '',
  })
}

/* ── Merge tickets ───────────────────────────────────────────── */

export async function mergeTickets(
  db: DbClient | DbPool,
  tenantId: string,
  primaryId: string,
  duplicateIds: string[],
  userId: string,
): Promise<void> {
  // Create links
  for (const dupId of duplicateIds) {
    if (dupId === primaryId) continue
    await db.query(
      `INSERT INTO ticket_links (tenant_id, ticket_id, linked_ticket_id, link_type)
       VALUES ($1, $2, $3, 'duplicates') ON CONFLICT DO NOTHING`,
      [tenantId, primaryId, dupId],
    )
    // Close duplicates
    await db.query(
      `UPDATE tickets SET status = 'closed', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND id != $3`,
      [dupId, tenantId, primaryId],
    )
    await logActivity(db, tenantId, dupId, userId, 'merged', { merged_into: primaryId })
  }
  await logActivity(db, tenantId, primaryId, userId, 'merge_received', { merged_from: duplicateIds })
}

/* ── Activity log ────────────────────────────────────────────── */

export interface TicketActivity {
  id: number
  ticket_id: string
  actor_id: string | null
  actor_name?: string
  action: string
  detail: Record<string, unknown>
  created_at: string
}

export async function logActivity(
  db: DbClient | DbPool,
  tenantId: string,
  ticketId: string,
  actorId: string,
  action: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO ticket_activity (tenant_id, ticket_id, actor_id, action, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, ticketId, actorId, action, JSON.stringify(detail)],
  )
}

export async function listActivity(db: DbClient | DbPool, tenantId: string, ticketId: string): Promise<TicketActivity[]> {
  const { rows } = await db.query(
    `SELECT a.*, u.name AS actor_name
     FROM ticket_activity a
     LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.tenant_id = $1 AND a.ticket_id = $2
     ORDER BY a.created_at DESC
     LIMIT 50`,
    [tenantId, ticketId],
  )
  return rows
}

/* ── Bulk actions ────────────────────────────────────────────── */

export async function bulkUpdateTickets(
  db: DbClient | DbPool,
  tenantId: string,
  ticketIds: string[],
  userId: string,
  updates: { status?: string; assignee_id?: string; team_id?: string; priority?: string },
): Promise<number> {
  const setClauses: string[] = ['updated_at = now()']
  const values: unknown[] = [tenantId]
  let idx = 2

  if (updates.status) { setClauses.push(`status = $${idx}`); values.push(updates.status); idx++ }
  if (updates.assignee_id !== undefined) { setClauses.push(`assignee_id = $${idx}`); values.push(updates.assignee_id); idx++ }
  if (updates.team_id !== undefined) {
    await assertTeamAcceptsTickets(db, tenantId, updates.team_id)
    setClauses.push(`team_id = $${idx}`); values.push(updates.team_id); idx++
  }
  if (updates.priority) { setClauses.push(`priority = $${idx}`); values.push(updates.priority); idx++ }

  values.push(ticketIds)
  const { rowCount } = await db.query(
    `UPDATE tickets SET ${setClauses.join(', ')}
     WHERE tenant_id = $1 AND id = ANY($${idx})`,
    values,
  )

  // Log activity for each
  for (const tid of ticketIds) {
    await logActivity(db, tenantId, tid, userId, 'bulk_updated', updates)
  }

  return rowCount ?? 0
}

/* ── Escalation paths (routing rules) ───────────────────────── */

export interface EscalationPath {
  id: number
  tenant_id: string
  name: string
  description: string
  source_team_id: string | null
  source_category_id: string | null
  source_priority: string[]
  target_team_id: string
  target_assignee_id: string | null
  auto_assign: boolean
  enabled: boolean
  position: number
  created_at: string
  target_team_name?: string
  target_assignee_name?: string
  source_team_name?: string
  source_category_name?: string
}

const ESCALATION_PATH_SELECT = `
  SELECT ep.*, tt.name AS target_team_name, ta.name AS target_assignee_name,
         st.name AS source_team_name, sc.name AS source_category_name
    FROM escalation_paths ep
    LEFT JOIN teams tt ON tt.id = ep.target_team_id
    LEFT JOIN users ta ON ta.id = ep.target_assignee_id
    LEFT JOIN teams st ON st.id = ep.source_team_id
    LEFT JOIN categories sc ON sc.id = ep.source_category_id
`

export async function listEscalationPaths(db: DbClient | DbPool, tenantId: string): Promise<EscalationPath[]> {
  const { rows } = await db.query(
    `${ESCALATION_PATH_SELECT} WHERE ep.tenant_id = $1 ORDER BY ep.position ASC, ep.created_at ASC`,
    [tenantId],
  )
  return rows
}

export async function createEscalationPath(
  db: DbClient | DbPool,
  tenantId: string,
  data: Partial<EscalationPath>,
): Promise<EscalationPath> {
  if (!data.target_team_id) throw new Error('target_team_id is required')
  const { rows } = await db.query(
    `INSERT INTO escalation_paths
       (tenant_id, name, description, source_team_id, source_category_id, source_priority,
        target_team_id, target_assignee_id, auto_assign, enabled, position)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      tenantId,
      data.name || 'Untitled path',
      data.description || '',
      data.source_team_id || null,
      data.source_category_id || null,
      data.source_priority || [],
      data.target_team_id,
      data.target_assignee_id || null,
      data.auto_assign ?? false,
      data.enabled ?? true,
      data.position ?? 0,
    ],
  )
  return rows[0]
}

export async function updateEscalationPath(
  db: DbClient | DbPool,
  tenantId: string,
  pathId: number,
  data: Partial<EscalationPath>,
): Promise<EscalationPath | null> {
  const allowed = ['name', 'description', 'source_team_id', 'source_category_id', 'source_priority', 'target_team_id', 'target_assignee_id', 'auto_assign', 'enabled', 'position'] as const
  const fields: string[] = []
  const values: unknown[] = []
  let idx = 3
  for (const key of allowed) {
    const val = data[key]
    if (val === undefined) continue
    fields.push(`${key} = $${idx}`)
    values.push(val)
    idx++
  }
  if (fields.length === 0) return null
  const { rows } = await db.query(
    `UPDATE escalation_paths SET ${fields.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [pathId, tenantId, ...values],
  )
  return rows[0] ?? null
}

export async function deleteEscalationPath(db: DbClient | DbPool, tenantId: string, pathId: number): Promise<boolean> {
  const { rowCount } = await db.query(
    'DELETE FROM escalation_paths WHERE id = $1 AND tenant_id = $2',
    [pathId, tenantId],
  )
  return (rowCount ?? 0) > 0
}

/**
 * Return the enabled paths that match a ticket's current team, category, and
 * priority. Used by the ticket detail to pre-fill the Escalate form. A path
 * matches when every non-empty condition matches (AND semantics).
 */
export async function matchEscalationPaths(
  db: DbClient | DbPool,
  tenantId: string,
  ticket: { team_id: string | null; category_id?: string | null; priority: string },
): Promise<EscalationPath[]> {
  const { rows } = await db.query(
    `${ESCALATION_PATH_SELECT}
      WHERE ep.tenant_id = $1 AND ep.enabled = true
        AND (ep.source_team_id IS NULL OR ep.source_team_id = $2)
        AND (ep.source_category_id IS NULL OR ep.source_category_id = $3)
        AND (cardinality(ep.source_priority) = 0 OR $4 = ANY(ep.source_priority))
      ORDER BY ep.position ASC, ep.created_at ASC`,
    [tenantId, ticket.team_id ?? null, ticket.category_id ?? null, ticket.priority],
  )
  return rows
}
