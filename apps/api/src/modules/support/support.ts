import type { DbPool } from '../../db/pool.js'

export interface SupportTicket {
  id: number
  user_id: string
  tenant_id: string | null
  number: number
  subject: string
  description: string | null
  category: string
  priority: string
  status: string
  assigned_to: string | null
  resolved_at: string | null
  created_at: string
  updated_at: string
  user_name?: string
  user_email?: string
  tenant_name?: string
}

export interface SupportTicketThread {
  id: number
  support_ticket_id: number
  author_id: string
  kind: string
  body: string
  created_at: string
  author_name?: string
}

export async function createSupportTicket(
  pool: DbPool,
  userId: string,
  tenantId: string | null,
  data: { subject: string; description?: string; category: string; priority: string },
): Promise<SupportTicket> {
  const { rows } = await pool.query(
    `INSERT INTO support_tickets (user_id, tenant_id, subject, description, category, priority)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [userId, tenantId, data.subject, data.description ?? null, data.category, data.priority],
  )
  return rows[0]
}

export async function listSupportTickets(
  pool: DbPool,
  options: { userId?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<SupportTicket[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  let idx = 1

  if (options.userId) {
    conditions.push(`st.user_id = $${idx++}`)
    params.push(options.userId)
  }
  if (options.status) {
    conditions.push(`st.status = $${idx++}`)
    params.push(options.status)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0

  const { rows } = await pool.query(
    `SELECT st.*, u.name AS user_name, u.email AS user_email, t.name AS tenant_name
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       LEFT JOIN tenants t ON t.id = st.tenant_id
       ${where}
       ORDER BY st.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
    [...params, limit, offset],
  )
  return rows
}

export async function getSupportTicket(
  pool: DbPool,
  ticketId: number,
): Promise<SupportTicket | null> {
  const { rows } = await pool.query(
    `SELECT st.*, u.name AS user_name, u.email AS user_email, t.name AS tenant_name
       FROM support_tickets st
       LEFT JOIN users u ON u.id = st.user_id
       LEFT JOIN tenants t ON t.id = st.tenant_id
       WHERE st.id = $1`,
    [ticketId],
  )
  return rows[0] ?? null
}

export async function updateSupportTicket(
  pool: DbPool,
  ticketId: number,
  data: { status?: string; assigned_to?: string | null; priority?: string },
): Promise<SupportTicket | null> {
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = []
  let idx = 1

  if (data.status) {
    sets.push(`status = $${idx++}`)
    params.push(data.status)
    if (data.status === 'resolved') {
      sets.push('resolved_at = now()')
    }
  }
  if (data.assigned_to !== undefined) {
    sets.push(`assigned_to = $${idx++}`)
    params.push(data.assigned_to)
  }
  if (data.priority) {
    sets.push(`priority = $${idx++}`)
    params.push(data.priority)
  }

  params.push(ticketId)
  const { rows } = await pool.query(
    `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  )
  return rows[0] ?? null
}

export async function addSupportTicketThread(
  pool: DbPool,
  ticketId: number,
  authorId: string,
  kind: string,
  body: string,
): Promise<SupportTicketThread> {
  const { rows } = await pool.query(
    `INSERT INTO support_ticket_threads (support_ticket_id, author_id, kind, body)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ticketId, authorId, kind, body],
  )
  return rows[0]
}

export async function getSupportTicketThreads(
  pool: DbPool,
  ticketId: number,
): Promise<SupportTicketThread[]> {
  const { rows } = await pool.query(
    `SELECT stt.*, u.name AS author_name
       FROM support_ticket_threads stt
       LEFT JOIN users u ON u.id = stt.author_id
       WHERE stt.support_ticket_id = $1
       ORDER BY stt.created_at ASC`,
    [ticketId],
  )
  return rows
}

// ---- Platform admin metrics (bypass RLS) ----

export interface PlatformMetrics {
  orgs: { total: number; active_30d: number }
  users: { total: number; active_30d: number }
  devices: { total: number; online: number }
  sessions: { total: number; active: number; last_30d: number }
  tickets: { total: number; open: number; resolved_30d: number }
  support_tickets: { total: number; open: number }
  recent_signups: { date: string; count: number }[]
}

export async function getPlatformMetrics(pool: DbPool): Promise<PlatformMetrics> {
  const [orgs, users, devices, sessions, tickets, supportTickets, recentSignups] = await Promise.all([
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS active_30d
      FROM tenants`),
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE last_login_at > now() - interval '30 days') AS active_30d
      FROM users`),
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE last_seen_at > now() - interval '5 minutes') AS online
      FROM devices`),
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE state = 'active') AS active,
      COUNT(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d
      FROM remote_sessions`),
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('new', 'open', 'in_progress', 'pending_user', 'escalated')) AS open,
      COUNT(*) FILTER (WHERE status IN ('resolved', 'closed') AND resolved_at > now() - interval '30 days') AS resolved_30d
      FROM tickets`),
    pool.query(`SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status IN ('open', 'in_progress', 'waiting_user')) AS open
      FROM support_tickets`),
    pool.query(`SELECT
      date_trunc('day', created_at)::date AS date,
      COUNT(*) AS count
      FROM tenants
      WHERE created_at > now() - interval '30 days'
      GROUP BY date_trunc('day', created_at)::date
      ORDER BY date DESC
      LIMIT 30`),
  ])

  return {
    orgs: { total: Number(orgs.rows[0].total), active_30d: Number(orgs.rows[0].active_30d) },
    users: { total: Number(users.rows[0].total), active_30d: Number(users.rows[0].active_30d) },
    devices: { total: Number(devices.rows[0].total), online: Number(devices.rows[0].online) },
    sessions: {
      total: Number(sessions.rows[0].total),
      active: Number(sessions.rows[0].active),
      last_30d: Number(sessions.rows[0].last_30d),
    },
    tickets: {
      total: Number(tickets.rows[0].total),
      open: Number(tickets.rows[0].open),
      resolved_30d: Number(tickets.rows[0].resolved_30d),
    },
    support_tickets: {
      total: Number(supportTickets.rows[0].total),
      open: Number(supportTickets.rows[0].open),
    },
    recent_signups: recentSignups.rows.map((r) => ({ date: String(r.date), count: Number(r.count) })),
  }
}

export async function listOrganizations(
  pool: DbPool,
  options: { limit?: number; offset?: number } = {},
): Promise<{ id: string; name: string; slug: string; created_at: string; user_count: number; device_count: number }[]> {
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.slug, t.created_at,
       (SELECT COUNT(*) FROM members m WHERE m.tenant_id = t.id) AS user_count,
       (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.id) AS device_count
       FROM tenants t
       ORDER BY t.created_at DESC
       LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
  return rows
}
