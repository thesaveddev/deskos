import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const teamSchema = z.object({
  name: z.string().trim().min(2).max(100),
  leadId: z.string().uuid().nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(200).default([]),
  createChat: z.boolean().default(false),
  acceptsTickets: z.boolean().default(true),
})

const teamUpdateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  leadId: z.string().uuid().nullable().optional(),
  memberIds: z.array(z.string().uuid()).max(200).optional(),
  createChat: z.boolean().optional(),
  acceptsTickets: z.boolean().optional(),
}).refine((body) => body.name !== undefined || body.leadId !== undefined || body.memberIds !== undefined || body.createChat !== undefined || body.acceptsTickets !== undefined, {
  message: 'Provide a team name or lead',
})

async function ensureLeadBelongsToTenant(app: FastifyInstance, tenantId: string, leadId: string | null | undefined): Promise<void> {
  if (!leadId) return
  const result = await app.db.query(
    `SELECT 1 FROM memberships WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'`,
    [tenantId, leadId],
  )
  if (!result.rows[0]) throw AppError.badRequest('The selected team lead is not an active member of this organization', 'invalid_team_lead')
}

async function ensureMembersBelongToTenant(client: DbClient, tenantId: string, userIds: string[]): Promise<string[]> {
  const uniqueIds = [...new Set(userIds)]
  if (uniqueIds.length === 0) return []
  const result = await client.query(
    `SELECT user_id FROM memberships
      WHERE tenant_id = $1 AND status = 'active' AND user_id = ANY($2::uuid[])`,
    [tenantId, uniqueIds],
  )
  const active = new Set(result.rows.map((row) => row.user_id as string))
  const invalid = uniqueIds.find((id) => !active.has(id))
  if (invalid) throw AppError.badRequest('Every selected team member must be an active member of this organization', 'invalid_team_member')
  return uniqueIds
}

async function syncTeamMembers(
  client: DbClient,
  tenantId: string,
  teamId: string,
  userIds: string[],
  addedBy: string,
): Promise<string[]> {
  const members = await ensureMembersBelongToTenant(client, tenantId, userIds)
  await client.query('DELETE FROM team_members WHERE tenant_id = $1 AND team_id = $2', [tenantId, teamId])
  for (const userId of members) {
    await client.query(
      `INSERT INTO team_members (tenant_id, team_id, user_id, added_by) VALUES ($1, $2, $3, $4)`,
      [tenantId, teamId, userId, addedBy],
    )
  }
  return members
}

async function syncTeamChat(
  client: DbClient,
  tenantId: string,
  teamId: string,
  teamName: string,
  createChat: boolean | undefined,
  createdBy: string,
): Promise<{ id: string; name: string } | null> {
  const existing = (await client.query(
    'SELECT id, name FROM chat_rooms WHERE tenant_id = $1 AND team_id = $2',
    [tenantId, teamId],
  )).rows[0]
  if (!existing && !createChat) return null
  if (existing) {
    if (existing.name !== teamName) {
      const renamed = await client.query(
        'UPDATE chat_rooms SET name = $2 WHERE id = $1 RETURNING id, name',
        [existing.id, teamName],
      )
      return renamed.rows[0]
    }
    return existing
  }

  const duplicate = await client.query('SELECT id FROM chat_rooms WHERE tenant_id = $1 AND name = $2', [tenantId, teamName])
  if (duplicate.rows[0]) throw AppError.conflict('A chat room with this name already exists. Choose a different team name.', 'chat_room_name_taken')
  const room = await client.query(
    `INSERT INTO chat_rooms (tenant_id, team_id, name, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name`,
    [tenantId, teamId, teamName, createdBy],
  )
  return room.rows[0]
}

export async function teamRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.get('/teams', { preHandler: [...guards, requirePermission('member.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const teams = await withTenant(app.db, ctx.tenantId, (client) =>
      client
        .query(
          `SELECT t.*, u.name AS lead_name, u.email AS lead_email,
                  (SELECT count(*)::int FROM tickets tk
                    WHERE tk.team_id = t.id AND tk.status NOT IN ('resolved', 'closed')) AS open_ticket_count,
                  (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count,
                  COALESCE((SELECT array_agg(tm.user_id) FROM team_members tm WHERE tm.team_id = t.id), ARRAY[]::uuid[]) AS member_ids,
                  cr.id AS chat_room_id,
                  cr.name AS chat_room_name
             FROM teams t
             LEFT JOIN users u ON u.id = t.lead_id
             LEFT JOIN chat_rooms cr ON cr.team_id = t.id
            ORDER BY lower(t.name)`,
        )
        .then((r) => r.rows),
    )
    return { teams }
  })

  app.post('/teams', { preHandler: [...guards, requirePermission('member.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = teamSchema.parse(request.body)
    await ensureLeadBelongsToTenant(app, ctx.tenantId, body.leadId)
    try {
      const team = await withTenant(app.db, ctx.tenantId, async (client) => {
        const created = await client.query(
          'INSERT INTO teams (tenant_id, name, lead_id, accepts_tickets) VALUES ($1, $2, $3, $4) RETURNING *',
          [ctx.tenantId, body.name, body.leadId ?? null, body.acceptsTickets],
        )
        const memberIds = body.leadId ? [...body.memberIds, body.leadId] : body.memberIds
        const syncedMemberIds = await syncTeamMembers(client, ctx.tenantId, created.rows[0].id, memberIds, request.user!.id)
        const chatRoom = await syncTeamChat(client, ctx.tenantId, created.rows[0].id, body.name, body.createChat, request.user!.id)
        return { ...created.rows[0], member_ids: syncedMemberIds, chat_room_id: chatRoom?.id ?? null, chat_room_name: chatRoom?.name ?? null }
      })
      return reply.code(201).send({ team })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        throw AppError.conflict('A team with this name already exists', 'team_name_taken')
      }
      throw err
    }
  })

  app.patch('/teams/:teamId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { teamId } = request.params as { teamId: string }
    const body = teamUpdateSchema.parse(request.body)
    await ensureLeadBelongsToTenant(app, ctx.tenantId, body.leadId)
    const sets: string[] = []
    const values: unknown[] = []
    if (body.name !== undefined) { values.push(body.name); sets.push(`name = $${values.length}`) }
    if (body.leadId !== undefined) { values.push(body.leadId); sets.push(`lead_id = $${values.length}`) }
    if (body.acceptsTickets !== undefined) { values.push(body.acceptsTickets); sets.push(`accepts_tickets = $${values.length}`) }
    const teamParam = values.length + 1
    const tenantParam = values.length + 2
    values.push(teamId, ctx.tenantId)
    try {
      const result = await withTenant(app.db, ctx.tenantId, async (client) => {
        const updated = sets.length > 0
          ? await client.query(`UPDATE teams SET ${sets.join(', ')} WHERE id = $${teamParam} AND tenant_id = $${tenantParam} RETURNING *`, values)
          : await client.query('SELECT * FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])
        if (!updated.rows[0]) throw AppError.notFound('Team not found')
        let memberIds: string[] = (await client.query('SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY created_at', [teamId])).rows.map((row) => row.user_id as string)
        if (body.memberIds !== undefined || body.leadId !== undefined) {
          memberIds = body.memberIds ?? memberIds
          if (body.leadId) memberIds.push(body.leadId)
          memberIds = await syncTeamMembers(client, ctx.tenantId, teamId, memberIds, request.user!.id)
        }
        const chatRoom = await syncTeamChat(client, ctx.tenantId, teamId, updated.rows[0].name, body.createChat, request.user!.id)
        return { ...updated.rows[0], member_ids: memberIds, chat_room_id: chatRoom?.id ?? null, chat_room_name: chatRoom?.name ?? null }
      })
      if (!result) throw AppError.notFound('Team not found')
      return reply.send({ team: result })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw AppError.conflict('A team with this name already exists', 'team_name_taken')
      throw err
    }
  })

  app.get('/teams/:teamId/members', { preHandler: [...guards, requirePermission('member.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { teamId } = request.params as { teamId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const team = (await client.query('SELECT id, name FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])).rows[0]
      if (!team) throw AppError.notFound('Team not found')
      const { rows } = await client.query(
        `SELECT tm.user_id, u.name, u.email, tm.added_by, tm.created_at
           FROM team_members tm JOIN users u ON u.id = tm.user_id
          WHERE tm.team_id = $1 ORDER BY lower(u.name), lower(u.email)`,
        [teamId],
      )
      return { team, members: rows }
    })
  })

  app.put('/teams/:teamId/members', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { teamId } = request.params as { teamId: string }
    const body = z.object({ userIds: z.array(z.string().uuid()).max(200) }).parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const team = (await client.query('SELECT id, lead_id FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])).rows[0]
      if (!team) throw AppError.notFound('Team not found')
      const userIds = team.lead_id ? [...body.userIds, team.lead_id] : body.userIds
      await syncTeamMembers(client, ctx.tenantId, teamId, userIds, request.user!.id)
      return { members: (await client.query('SELECT user_id FROM team_members WHERE team_id = $1 ORDER BY created_at', [teamId])).rows }
    })
  })

  app.delete('/teams/:teamId/members/:userId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { teamId, userId } = request.params as { teamId: string; userId: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const team = (await client.query('SELECT id, lead_id FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])).rows[0]
      if (!team) throw AppError.notFound('Team not found')
      if (team.lead_id === userId) throw AppError.conflict('The team lead must remain a team member', 'team_lead_member_required')
      const removed = await client.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2 RETURNING user_id', [teamId, userId])
      if (!removed.rows[0]) throw AppError.notFound('Team member not found')
      return { ok: true }
    })
  })

  app.delete('/teams/:teamId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { teamId } = request.params as { teamId: string }
    await withTenant(app.db, ctx.tenantId, async (client) => {
      const team = await client.query('SELECT id FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])
      if (!team.rows[0]) throw AppError.notFound('Team not found')
      const usage = await client.query(`SELECT count(*)::int AS count FROM tickets WHERE team_id = $1 AND status NOT IN ('resolved', 'closed')`, [teamId])
      if (Number(usage.rows[0]?.count ?? 0) > 0) throw AppError.conflict('Reassign open tickets before deleting this team', 'team_in_use')
      await client.query('DELETE FROM teams WHERE id = $1 AND tenant_id = $2', [teamId, ctx.tenantId])
    })
    return reply.send({ ok: true })
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
