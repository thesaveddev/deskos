import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'

export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4', 'sev5'] as const
export type Severity = (typeof SEVERITIES)[number]
export const INCIDENT_STATUSES = ['open', 'investigating', 'identified', 'mitigated', 'resolved', 'closed'] as const
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number]

const SEVERITY_PRIORITY: Record<Severity, string> = { sev1: 'p1', sev2: 'p1', sev3: 'p2', sev4: 'p3', sev5: 'p4' }

export interface DeclareInput {
  subject: string
  description?: string
  severity?: Severity
  commanderId?: string
}

export interface UpdateInput {
  severity?: Severity
  status?: IncidentStatus
  commanderId?: string | null
}

export async function declareIncident(
  pool: DbPool,
  tenantId: string,
  actorId: string,
  input: DeclareInput,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const severity = input.severity ?? 'sev3'
    if (input.commanderId) {
      const cmdr = await client.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3', [tenantId, input.commanderId, 'active'])
      if (!cmdr.rows[0]) throw AppError.badRequest('Commander must be an active member', 'invalid_commander')
    }
    const counter = await client.query('UPDATE tenants SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter', [tenantId])
    const number = counter.rows[0].ticket_counter as number
    const priority = SEVERITY_PRIORITY[severity]
    const ticket = (
      await client.query(
        `INSERT INTO tickets (tenant_id, number, type, status, priority, subject, requester_id, source)
         VALUES ($1, $2, 'major_incident', 'open', $3, $4, $5, 'technician')
         RETURNING *`,
        [tenantId, number, priority, input.subject, actorId],
      )
    ).rows[0]
    const incident = (
      await client.query(
        `INSERT INTO major_incidents (tenant_id, ticket_id, severity, status, commander_id, declared_by)
         VALUES ($1, $2, $3, 'open', $4, $5)
         RETURNING *`,
        [tenantId, ticket.id, severity, input.commanderId ?? null, actorId],
      )
    ).rows[0]
    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
       VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
      [tenantId, ticket.id, `Major incident declared (${severity}).`, JSON.stringify({ event: 'major_incident.declared', severity })],
    )
    if (input.description) {
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
         VALUES ($1, $2, $3, 'message', 'public', $4)`,
        [tenantId, ticket.id, actorId, input.description],
      )
    }
    return { incident: { ...incident, number: ticket.number, subject: ticket.subject, priority: ticket.priority }, ticketId: ticket.id }
  })
}

export async function listIncidents(
  pool: DbPool,
  tenantId: string,
  filters: { status?: IncidentStatus; severity?: Severity } = {},
): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const where: string[] = []
    const params: unknown[] = []
    if (filters.status) {
      params.push(filters.status)
      where.push(`mi.status = $${params.length}`)
    }
    if (filters.severity) {
      params.push(filters.severity)
      where.push(`mi.severity = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT mi.*, t.number, t.subject, t.priority, t.status AS ticket_status, u.name AS commander_name
         FROM major_incidents mi
         JOIN tickets t ON t.id = mi.ticket_id
         LEFT JOIN users u ON u.id = mi.commander_id
         ${whereSql}
        ORDER BY CASE mi.severity WHEN 'sev1' THEN 0 WHEN 'sev2' THEN 1 WHEN 'sev3' THEN 2 WHEN 'sev4' THEN 3 ELSE 4 END,
                 mi.created_at DESC
        LIMIT 200`,
      params,
    )
    return rows
  })
}

export async function getIncident(pool: DbPool, tenantId: string, id: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT mi.*, t.number, t.subject, t.priority, t.status AS ticket_status, u.name AS commander_name
         FROM major_incidents mi
         JOIN tickets t ON t.id = mi.ticket_id
         LEFT JOIN users u ON u.id = mi.commander_id
        WHERE mi.id = $1`,
      [id],
    )
    if (!rows[0]) throw AppError.notFound('Major incident not found')
    const links = await client.query(
      `SELECT l.id, l.link_type, t2.number AS target_number, t2.subject AS target_subject,
              t2.status AS target_status, t2.priority AS target_priority
         FROM ticket_links l
         JOIN tickets t2 ON t2.id = l.target_id AND l.target_type = 'ticket'
        WHERE l.ticket_id = $1
        ORDER BY l.created_at`,
      [rows[0].ticket_id],
    )
    return { incident: rows[0], links: links.rows }
  })
}

export async function updateIncident(
  pool: DbPool,
  tenantId: string,
  id: string,
  input: UpdateInput,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = (await client.query('SELECT * FROM major_incidents WHERE id = $1', [id])).rows[0]
    if (!existing) throw AppError.notFound('Major incident not found')

    if (input.commanderId !== undefined && input.commanderId !== null) {
      const cmdr = await client.query('SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = $3', [tenantId, input.commanderId, 'active'])
      if (!cmdr.rows[0]) throw AppError.badRequest('Commander must be an active member', 'invalid_commander')
    }

    const sets: string[] = []
    const params: unknown[] = []
    let idx = 1
    const push = (col: string, val: unknown) => {
      params.push(val)
      sets.push(`${col} = $${idx++}`)
    }
    if (input.severity !== undefined) push('severity', input.severity)
    if (input.commanderId !== undefined) push('commander_id', input.commanderId)
    if (input.status !== undefined) {
      push('status', input.status)
      if (input.status === 'resolved' || input.status === 'closed') {
        if (!existing.resolved_at) push('resolved_at', new Date())
      } else {
        push('resolved_at', null)
      }
    }
    push('updated_at', new Date())
    params.push(id)
    const { rows } = await client.query(`UPDATE major_incidents SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params)

    const newStatus = (input.status ?? existing.status) as IncidentStatus
    const ticketStatus = newStatus === 'resolved' || newStatus === 'closed' ? 'resolved' : 'open'
    await client.query('UPDATE tickets SET status = $1, updated_at = now() WHERE id = $2', [ticketStatus, existing.ticket_id])

    const changes: string[] = []
    if (input.severity !== undefined) changes.push(`severity=${input.severity}`)
    if (input.status !== undefined) changes.push(`status=${input.status}`)
    if (input.commanderId !== undefined) changes.push('commander updated')
    if (changes.length) {
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
         VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
        [tenantId, existing.ticket_id, `Major incident updated: ${changes.join(', ')}`, JSON.stringify({ event: 'major_incident.updated', ...input })],
      )
    }
    return rows[0]
  })
}

export async function bridgeIncident(
  pool: DbPool,
  tenantId: string,
  id: string,
  targetTicketId: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const incident = (await client.query('SELECT ticket_id FROM major_incidents WHERE id = $1', [id])).rows[0]
    if (!incident) throw AppError.notFound('Major incident not found')
    const target = (await client.query('SELECT number, subject FROM tickets WHERE id = $1', [targetTicketId])).rows[0]
    if (!target) throw AppError.notFound('Ticket not found')

    const existing = (
      await client.query(
        'SELECT id FROM ticket_links WHERE ticket_id = $1 AND target_type = $2 AND target_id = $3 AND link_type = $4',
        [incident.ticket_id, 'ticket', targetTicketId, 'related'],
      )
    ).rows[0]
    if (existing) return { linkId: existing.id, duplicate: true }

    const { rows } = await client.query(
      `INSERT INTO ticket_links (tenant_id, ticket_id, link_type, target_type, target_id)
       VALUES ($1, $2, 'related', 'ticket', $3) RETURNING id`,
      [tenantId, incident.ticket_id, targetTicketId],
    )
    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
       VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
      [tenantId, incident.ticket_id, `Bridged incident #${target.number}: ${target.subject}`, JSON.stringify({ event: 'major_incident.bridged', targetTicketId })],
    )
    return { linkId: rows[0].id, duplicate: false }
  })
}
