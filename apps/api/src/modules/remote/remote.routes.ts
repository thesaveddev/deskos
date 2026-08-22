import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AppError } from '../../core/errors.js'
import { roleHasPermission, type Permission } from '../../core/permissions.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticateAgent } from '../devices/device-auth.js'
import { notify } from '../../core/notify.js'
import { hasActiveGrant } from '../grants/grants.js'
import { createRelayTicket, type RelayAudience } from './relay-ticket.js'
import { buildIceServers } from '../../core/ice.js'
import '../../types.js'

const sessionTypes = ['attended', 'unattended', 'inspection'] as const
const sessionStates = ['requested', 'consent_pending', 'connecting', 'active', 'reconnecting', 'ended', 'denied', 'expired'] as const
const LIVE_SESSION_STATES = new Set<string>(['requested', 'consent_pending', 'connecting', 'active', 'reconnecting'])
export const sessionPermissions = ['view_screen', 'control_input', 'terminal', 'file_transfer', 'clipboard', 'system_manage', 'elevation', 'reboot_reconnect'] as const

const createSchema = z.object({
  deviceId: z.string().uuid(),
  ticketId: z.string().uuid().optional(),
  type: z.enum(sessionTypes).default('attended'),
  permissions: z.array(z.enum(sessionPermissions)).min(1).max(10),
  reason: z.string().trim().max(500).optional(),
  recordingMode: z.enum(['off', 'metadata', 'video']).optional(),
  recordingRetentionDays: z.number().int().min(1).max(3650).optional(),
})

const consentSchema = z.object({
  granted: z.boolean(),
  permissions: z.array(z.enum(sessionPermissions)).min(1).max(10).optional(),
})
const messageSchema = z.object({ body: z.string().trim().min(1).max(2000) })
const recordingStateSchema = z.object({
  state: z.enum(['recording', 'stopped', 'failed']),
  reason: z.string().trim().max(240).optional(),
})
const inviteSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['technician', 'observer']).default('technician'),
})
const transferSchema = z.object({ userId: z.string().uuid() })
const agentStateSchema = z.object({ state: z.enum(['connecting', 'active', 'reconnecting', 'ended']) })
const controlAuditSchema = z.object({
  outcome: z.enum(['accepted', 'rejected']),
  action: z.enum(['pointermove', 'pointerdown', 'pointerup', 'click', 'wheel', 'keydown', 'keyup', 'clipboard_get', 'clipboard_set', 'terminal_start', 'terminal_input', 'terminal_close', 'file_list', 'file_download', 'file_upload', 'process_list', 'process_terminate', 'service_list', 'service_start', 'service_stop', 'unknown']),
  reason: z.string().trim().max(120).optional(),
})

const agentDiagnosticSchema = z.object({
  event: z.enum([
    'relay.joined',
    'relay.peer_joined',
    'relay.disconnected',
    'relay.error',
    'webrtc.offer_received',
    'webrtc.answer_sent',
    'webrtc.error',
    'screen.publisher_started',
    'screen.frame_encoded',
    'screen.capture_error',
  ]),
  reason: z.string().trim().max(240).optional(),
})

function controlAuditEvent(body: z.infer<typeof controlAuditSchema>): string {
  if (body.action === 'clipboard_get') return body.outcome === 'accepted' ? 'session.clipboard.read' : 'session.clipboard.rejected'
  if (body.action === 'clipboard_set') return body.outcome === 'accepted' ? 'session.clipboard.write' : 'session.clipboard.rejected'
  if (body.action === 'terminal_start') return body.outcome === 'accepted' ? 'session.terminal.started' : 'session.terminal.rejected'
  if (body.action === 'terminal_input') return body.outcome === 'accepted' ? 'session.terminal.input' : 'session.terminal.rejected'
  if (body.action === 'terminal_close') return body.outcome === 'accepted' ? 'session.terminal.closed' : 'session.terminal.rejected'
  if (body.action === 'file_list') return body.outcome === 'accepted' ? 'session.files.listed' : 'session.files.rejected'
  if (body.action === 'file_download') return body.outcome === 'accepted' ? 'session.files.downloaded' : 'session.files.rejected'
  if (body.action === 'file_upload') return body.outcome === 'accepted' ? 'session.files.uploaded' : 'session.files.rejected'
  if (body.action === 'process_list') return body.outcome === 'accepted' ? 'session.processes.listed' : 'session.system.rejected'
  if (body.action === 'process_terminate') return body.outcome === 'accepted' ? 'session.processes.terminated' : 'session.system.rejected'
  if (body.action === 'service_list') return body.outcome === 'accepted' ? 'session.services.listed' : 'session.system.rejected'
  if (body.action === 'service_start') return body.outcome === 'accepted' ? 'session.services.started' : 'session.system.rejected'
  if (body.action === 'service_stop') return body.outcome === 'accepted' ? 'session.services.stopped' : 'session.system.rejected'
  return body.outcome === 'accepted' ? 'session.input.accepted' : 'session.input.rejected'
}

function controlAuditPayload(body: z.infer<typeof controlAuditSchema>): Record<string, unknown> {
  return {
    action: body.action,
    ...(body.reason ? { reason: body.reason } : {}),
  }
}

function requiredPermission(type: (typeof sessionTypes)[number]): Permission {
  return type === 'attended' ? 'remote.attended' : type === 'unattended' ? 'remote.unattended' : 'remote.inspection'
}

export function canManageSessions(role: Parameters<typeof roleHasPermission>[0]): boolean {
  return ['remote.attended', 'remote.unattended', 'remote.inspection'].some((permission) => roleHasPermission(role, permission as Permission))
}

export function assertSessionPermission(
  role: Parameters<typeof roleHasPermission>[0],
  type: (typeof sessionTypes)[number],
  permissions: readonly string[],
  reason?: string,
  elevationOverride = false,
): void {
  if (!roleHasPermission(role, requiredPermission(type))) {
    throw AppError.forbidden(`Missing permission: ${requiredPermission(type)}`, 'missing_permission')
  }
  if (permissions.includes('control_input') && !roleHasPermission(role, 'remote.control')) {
    throw AppError.forbidden('Input control requires remote.control permission', 'control_not_allowed')
  }
  if (permissions.includes('clipboard') && !roleHasPermission(role, 'remote.control')) {
    throw AppError.forbidden('Clipboard access requires remote.control permission', 'clipboard_not_allowed')
  }
  if (permissions.includes('terminal') && !roleHasPermission(role, 'remote.control')) {
    throw AppError.forbidden('Terminal access requires remote.control permission', 'terminal_not_allowed')
  }
  if (permissions.includes('file_transfer') && !roleHasPermission(role, 'remote.control')) {
    throw AppError.forbidden('File transfer requires remote.control permission', 'file_transfer_not_allowed')
  }
  if (permissions.includes('system_manage') && !roleHasPermission(role, 'remote.control')) {
    throw AppError.forbidden('Process and service management requires remote.control permission', 'system_manage_not_allowed')
  }
  if (permissions.includes('terminal') && !permissions.includes('elevation')) {
    throw AppError.badRequest('Terminal access must explicitly include elevation until user-scoped shells are available', 'terminal_elevation_required')
  }
  if (permissions.includes('system_manage') && !permissions.includes('elevation')) {
    throw AppError.badRequest('Process and service management must explicitly include elevation', 'system_manage_elevation_required')
  }
  if (permissions.includes('elevation') && !roleHasPermission(role, 'remote.elevated') && !elevationOverride) {
    throw AppError.forbidden('Elevation requires remote.elevated permission or an active JIT grant', 'elevation_not_allowed')
  }
  if (type === 'unattended' && !reason) {
    throw AppError.badRequest('A reason is required for unattended sessions', 'reason_required')
  }
}

async function addSessionEvent(
  client: DbClient,
  tenantId: string,
  sessionId: string,
  event: string,
  actorType: 'user' | 'agent' | 'system',
  actorId: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO session_events (tenant_id, session_id, actor_type, actor_id, event, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [tenantId, sessionId, actorType, actorId, event, JSON.stringify(payload)],
  )
}

const TICKET_TIMELINE_BODY_MAX = 240

/** Append a session activity line to the linked ticket's thread when one exists. */
async function appendTicketTimeline(
  client: DbClient,
  tenantId: string,
  sessionId: string,
  event: string,
  body: string,
  actorType: 'user' | 'agent' | 'system' = 'system',
  actorId: string | null = null,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const session = (await client.query('SELECT ticket_id FROM remote_sessions WHERE id = $1', [sessionId])).rows[0]
  if (!session?.ticket_id) return
  await client.query(
    `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
     VALUES ($1, $2, $3, 'session_record', 'internal', $4, $5::jsonb)`,
    [
      tenantId,
      session.ticket_id,
      actorType === 'user' ? actorId : null,
      body.slice(0, TICKET_TIMELINE_BODY_MAX),
      JSON.stringify({ event, sessionId, ...meta }),
    ],
  )
}

async function issueJoinToken(
  client: DbClient,
  app: FastifyInstance,
  tenantId: string,
  sessionId: string,
  audience: RelayAudience,
): Promise<string> {
  const ticket = createRelayTicket(app.config.relaySecret, sessionId, audience)
  await client.query(
    `INSERT INTO session_join_tokens (tenant_id, session_id, audience, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, sessionId, audience, ticket.hash, ticket.expiresAt],
  )
  return ticket.token
}

export async function remoteRoutes(app: FastifyInstance): Promise<void> {
  const userGuards = [authenticate, requireTenant]

  app.post('/sessions', { preHandler: userGuards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const tenantRow = (await app.db.query('SELECT settings FROM tenants WHERE id = $1', [ctx.tenantId])).rows[0]
    const remoteDefaults = (tenantRow?.settings?.remote_support ?? {}) as Record<string, unknown>
    const recordingMode = (body.recordingMode ?? remoteDefaults.default_recording_mode ?? 'metadata') as 'off' | 'metadata' | 'video'
    const recordingRetentionDays = Number(body.recordingRetentionDays ?? remoteDefaults.recording_retention_days ?? 30)
    const elevationOverride = body.permissions.includes('elevation')
      ? await hasActiveGrant(app.db, ctx.tenantId, request.user!.id, 'remote.elevated', body.deviceId)
      : false
    assertSessionPermission(ctx.orgRole, body.type, body.permissions, body.reason, elevationOverride)

    const result = await withTenant(app.db, ctx.tenantId, async (client) => {
      const device = (await client.query('SELECT id, name FROM devices WHERE id = $1', [body.deviceId])).rows[0]
      if (!device) throw AppError.notFound('Device not found')
      if (body.ticketId) {
        const ticket = (await client.query('SELECT id FROM tickets WHERE id = $1', [body.ticketId])).rows[0]
        if (!ticket) throw AppError.notFound('Ticket not found')
      }

      const state = body.type === 'attended' ? 'consent_pending' : body.type === 'inspection' ? 'connecting' : 'requested'
      const session = (
        await client.query(
          `INSERT INTO remote_sessions
             (tenant_id, device_id, ticket_id, type, state, permissions, reason, requested_by, recording_mode, recording_retention_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [ctx.tenantId, body.deviceId, body.ticketId ?? null, body.type, state, body.permissions, body.reason ?? '', request.user!.id, recordingMode, recordingRetentionDays],
        )
      ).rows[0]
      await client.query(
        `INSERT INTO session_participants (tenant_id, session_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (session_id, user_id) DO UPDATE SET role = 'owner'`,
        [ctx.tenantId, session.id, request.user!.id],
      )
      const joinToken = await issueJoinToken(client, app, ctx.tenantId, session.id, 'technician')
      await addSessionEvent(client, ctx.tenantId, session.id, 'session.created', 'user', request.user!.id, {
        type: body.type,
        deviceId: body.deviceId,
        ticketId: body.ticketId ?? null,
        permissions: body.permissions,
      })
      if (body.ticketId) {
        await appendTicketTimeline(client, ctx.tenantId, session.id, 'session.created', `Remote ${body.type} session requested for ${device.name}.`, 'user', request.user!.id, { type: body.type })
      }
      app.metrics.sessionCreated()
      return { session, joinToken }
    })

    return reply.code(201).send(result)
  })

  app.get('/sessions', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const query = request.query as { state?: string; deviceId?: string; limit?: string; offset?: string; cursor?: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const values: unknown[] = []
      const clauses: string[] = []
      if (query.state && sessionStates.includes(query.state as (typeof sessionStates)[number])) {
        values.push(query.state)
        clauses.push(`s.state = $${values.length}`)
      }
      if (query.deviceId) {
        values.push(query.deviceId)
        clauses.push(`s.device_id = $${values.length}`)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      const limit = Math.min(Number(query.limit ?? 50), 200)
      const offset = Math.max(0, Number(query.offset ?? 0))

      const countResult = await client.query(
        `SELECT COUNT(*)::int AS total FROM remote_sessions s ${where}`,
        values,
      )
      const total = countResult.rows[0]?.total ?? 0

      const sessions = await client.query(
        `SELECT s.*, d.name AS device_name, d.hostname, t.number AS ticket_number, u.name AS requested_by_name
           FROM remote_sessions s
           JOIN devices d ON d.id = s.device_id
           LEFT JOIN tickets t ON t.id = s.ticket_id
           JOIN users u ON u.id = s.requested_by
           ${where}
          ORDER BY s.created_at DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, offset],
      )
      return { sessions: sessions.rows, total, nextCursor: null }
    })
  })

  app.post('/sessions/:id/join', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('Session is no longer joinable', 'invalid_session_state')
      }
      const joinToken = await issueJoinToken(client, app, ctx.tenantId, id, 'technician')
      await addSessionEvent(client, ctx.tenantId, id, 'session.technician_join_ticket_issued', 'user', request.user!.id)
      return { session, joinToken }
    })
  })

  app.get('/sessions/:id', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (
        await client.query(
          `SELECT s.*, d.name AS device_name, d.hostname, d.os, d.os_version, t.number AS ticket_number
             FROM remote_sessions s
             JOIN devices d ON d.id = s.device_id
             LEFT JOIN tickets t ON t.id = s.ticket_id
            WHERE s.id = $1`,
          [id],
        )
      ).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      const events = await client.query(
        `SELECT id, actor_type, actor_id, event, payload, created_at
           FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
        [id],
      )
      return { session, events: events.rows }
    })
  })

  app.get('/sessions/:id/ice', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      return { iceServers: buildIceServers(app.config.ice) }
    })
  })

  app.post('/sessions/:id/end', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (session.state === 'ended') return { session }
      const wasLive = LIVE_SESSION_STATES.has(session.state)
      const updated = (
        await client.query(
          `UPDATE remote_sessions SET state = 'ended', ended_at = COALESCE(ended_at, now()), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id],
        )
      ).rows[0]
      if (wasLive) app.metrics.sessionTerminated()
      await addSessionEvent(client, ctx.tenantId, id, 'session.ended', 'user', request.user!.id)
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.ended', 'Remote session ended.', 'user', request.user!.id)
      await client.query(
        `UPDATE devices
            SET agent_token_hash = CASE WHEN adhoc THEN NULL ELSE agent_token_hash END,
                agent_token_expires_at = CASE WHEN adhoc THEN now() ELSE agent_token_expires_at END,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [session.device_id, ctx.tenantId],
      )
      await client.query("UPDATE adhoc_sessions SET state = 'ended', updated_at = now() WHERE remote_session_id = $1 AND state = 'claimed'", [id])
      return { session: updated }
    })
  })

  app.get('/sessions/:id/events', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, (client) =>
      client.query(
        `SELECT id, actor_type, actor_id, event, payload, created_at
           FROM session_events WHERE session_id = $1 ORDER BY created_at ASC`,
        [id],
      ).then((result) => ({ events: result.rows })),
    )
  })

  app.get('/sessions/:id/messages', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      const messages = await client.query(
        `SELECT m.id, m.sender_type, m.sender_id, m.body, m.created_at, u.name AS sender_name
           FROM session_messages m
           LEFT JOIN users u ON u.id = m.sender_id AND m.sender_type = 'technician'
          WHERE m.session_id = $1
          ORDER BY m.created_at ASC
          LIMIT 200`,
        [id],
      )
      return { messages: messages.rows }
    })
  })

  app.post('/sessions/:id/messages', { preHandler: userGuards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    const body = messageSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('Session is no longer accepting messages', 'invalid_session_state')
      }
      const message = (
        await client.query(
          `INSERT INTO session_messages (tenant_id, session_id, sender_type, sender_id, body)
           VALUES ($1, $2, 'technician', $3, $4) RETURNING id, sender_type, sender_id, body, created_at`,
          [ctx.tenantId, id, request.user!.id, body.body],
        )
      ).rows[0]
      await addSessionEvent(client, ctx.tenantId, id, 'session.chat.sent', 'user', request.user!.id, { chars: body.body.length })
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.chat.sent', `Chat (technician): ${body.body}`, 'user', request.user!.id)
      return reply.code(201).send({ message })
    })
  })

  app.get('/sessions/:id/participants', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      const participants = await client.query(
        `SELECT p.id, p.user_id, p.role, p.created_at, u.name, u.email
           FROM session_participants p
           JOIN users u ON u.id = p.user_id
          WHERE p.session_id = $1
          ORDER BY p.created_at ASC`,
        [id],
      )
      return { participants: participants.rows }
    })
  })

  app.post('/sessions/:id/invite', { preHandler: userGuards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    const body = inviteSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('Session is no longer joinable', 'invalid_session_state')
      }
      if (body.userId === request.user!.id) throw AppError.badRequest('You are already a participant in this session', 'self_invite')
      const target = (
        await client.query(
          `SELECT u.id FROM users u
             JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.status = 'active'
            WHERE u.id = $1`,
          [body.userId, ctx.tenantId],
        )
      ).rows[0]
      if (!target) throw AppError.notFound('User not found in this tenant')
      const participant = (
        await client.query(
          `INSERT INTO session_participants (tenant_id, session_id, user_id, role)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (session_id, user_id) DO UPDATE SET role = EXCLUDED.role
           RETURNING id, user_id, role, created_at`,
          [ctx.tenantId, id, body.userId, body.role],
        )
      ).rows[0]
      await notify(client, ctx.tenantId, {
        userId: body.userId,
        kind: 'session_invite',
        subjectType: 'session',
        subjectId: id,
        body: `${request.user!.name} invited you to a remote session.`,
      })
      await addSessionEvent(client, ctx.tenantId, id, 'session.participant_invited', 'user', request.user!.id, { userId: body.userId, role: body.role })
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.participant_invited', `A ${body.role} was invited to the session.`, 'user', request.user!.id, { userId: body.userId })
      return reply.code(201).send({ participant })
    })
  })

  app.post('/sessions/:id/transfer', { preHandler: userGuards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id } = request.params as { id: string }
    const body = transferSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state, requested_by FROM remote_sessions WHERE id = $1', [id])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('Session is no longer transferable', 'invalid_session_state')
      }
      const ownership = (await client.query('SELECT role FROM session_participants WHERE session_id = $1 AND user_id = $2', [id, request.user!.id])).rows[0]
      const isOwner = ownership?.role === 'owner' || session.requested_by === request.user!.id
      if (!isOwner) throw AppError.forbidden('Only the session owner can transfer ownership', 'transfer_not_allowed')
      if (body.userId === request.user!.id) throw AppError.badRequest('The session is already owned by you', 'self_transfer')
      const target = (
        await client.query(
          `SELECT u.id FROM users u
             JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $2 AND m.status = 'active'
            WHERE u.id = $1`,
          [body.userId, ctx.tenantId],
        )
      ).rows[0]
      if (!target) throw AppError.notFound('User not found in this tenant')
      await client.query(`UPDATE session_participants SET role = 'technician' WHERE session_id = $1 AND role = 'owner'`, [id])
      const owner = (
        await client.query(
          `INSERT INTO session_participants (tenant_id, session_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT (session_id, user_id) DO UPDATE SET role = 'owner'
           RETURNING id, user_id, role, created_at`,
          [ctx.tenantId, id, body.userId],
        )
      ).rows[0]
      await addSessionEvent(client, ctx.tenantId, id, 'session.ownership_transferred', 'user', request.user!.id, { fromUserId: request.user!.id, toUserId: body.userId })
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.ownership_transferred', 'Session ownership was transferred.', 'user', request.user!.id, { toUserId: body.userId })
      return { participant: owner }
    })
  })

  // Agent polling also reconciles active reboot-reconnect sessions when the service starts.
  app.get('/agent/sessions', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    return withTenant(app.db, ctx.tenantId, (client) =>
      client.query(
        `SELECT id, device_id, ticket_id, type, state, permissions, reason, requested_by, created_at, updated_at
           FROM remote_sessions
          WHERE device_id = $1
            AND (
              state IN ('requested', 'consent_pending', 'connecting', 'reconnecting')
              OR (state = 'active' AND 'reboot_reconnect' = ANY(permissions))
            )
          ORDER BY created_at ASC`,
        [ctx.deviceId],
      ).then((result) => ({ sessions: result.rows })),
    )
  })

  app.get('/agent/sessions/:id/ice', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      return { iceServers: buildIceServers(app.config.ice) }
    })
  })

  app.post('/agent/sessions/:id/join', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query("SELECT * FROM remote_sessions WHERE id = $1 AND device_id = $2 AND type = 'inspection'", [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Inspection session not found')
      if (session.state !== 'connecting') throw AppError.conflict('Inspection session is not connectable', 'invalid_session_state')
      const joinToken = await issueJoinToken(client, app, ctx.tenantId, id, 'agent')
      await addSessionEvent(client, ctx.tenantId, id, 'session.agent_join_ticket_issued', 'agent', ctx.deviceId)
      return reply.send({ session, joinToken })
    })
  })

  app.post('/agent/sessions/:id/consent', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = consentSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (!['requested', 'consent_pending'].includes(session.state)) throw AppError.conflict('Session is no longer awaiting consent', 'invalid_session_state')
      if (!body.granted) {
        const denied = (await client.query("UPDATE remote_sessions SET state = 'denied', updated_at = now() WHERE id = $1 RETURNING *", [id])).rows[0]
        app.metrics.sessionTerminated()
        await addSessionEvent(client, ctx.tenantId, id, 'session.consent_denied', 'agent', ctx.deviceId)
        await appendTicketTimeline(client, ctx.tenantId, id, 'session.consent_denied', 'Remote session consent was declined.', 'agent', ctx.deviceId)
        await client.query(
          `UPDATE devices
              SET agent_token_hash = CASE WHEN adhoc THEN NULL ELSE agent_token_hash END,
                  agent_token_expires_at = CASE WHEN adhoc THEN now() ELSE agent_token_expires_at END,
                  updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [ctx.deviceId, ctx.tenantId],
        )
        await client.query("UPDATE adhoc_sessions SET state = 'ended', updated_at = now() WHERE remote_session_id = $1 AND state = 'claimed'", [id])
        return reply.send({ session: denied })
      }
      // The endpoint may consent to screen sharing while refusing elevated
      // access. Accept a reduced permission set so terminal and process/service
      // management can be declined without rejecting the whole session.
      const requested = session.permissions as string[]
      let effective = requested
      if (body.permissions) {
        effective = body.permissions.filter((permission) => requested.includes(permission))
        if (!effective.includes('view_screen')) effective = ['view_screen', ...effective]
      }
      const elevationReduced = effective.length < requested.length
      const updated = (
        await client.query(
          `UPDATE remote_sessions SET state = 'connecting', permissions = $2, consented_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, effective],
        )
      ).rows[0]
      const joinToken = await issueJoinToken(client, app, ctx.tenantId, id, 'agent')
      await addSessionEvent(client, ctx.tenantId, id, 'session.consent_granted', 'agent', ctx.deviceId, elevationReduced ? { permissions: effective } : {})
      if (elevationReduced) {
        await addSessionEvent(client, ctx.tenantId, id, 'session.elevation_denied', 'agent', ctx.deviceId, { permissions: effective })
      }
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.consent_granted', 'Remote session consent granted.', 'agent', ctx.deviceId, elevationReduced ? { permissions: effective } : {})
      // Instantly notify the technician so they can open the session console
      // without waiting for the next poll cycle.
      if (session.requested_by) {
        const deviceRow = (await client.query('SELECT name FROM devices WHERE id = $1 AND tenant_id = $2', [ctx.deviceId, ctx.tenantId])).rows[0]
        await notify(client, ctx.tenantId, {
          userId: session.requested_by,
          kind: 'session.adhoc.claimed',
          body: `${deviceRow?.name ?? 'Device'} accepted the remote support session. Click to open the session console.`,
          subjectType: 'session',
          subjectId: id,
        })
      }
      return reply.send({ session: updated, joinToken })
    })
  })

  app.post('/agent/sessions/:id/reconnect', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (!['connecting', 'active', 'reconnecting'].includes(session.state)) {
        throw AppError.conflict('Session is not eligible for reconnect', 'invalid_session_state')
      }
      const updated = (
        await client.query(
          `UPDATE remote_sessions SET state = 'reconnecting', updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id],
        )
      ).rows[0]
      const joinToken = await issueJoinToken(client, app, ctx.tenantId, id, 'agent')
      await addSessionEvent(client, ctx.tenantId, id, 'session.agent_reconnect_ticket_issued', 'agent', ctx.deviceId, {
        previousState: session.state,
      })
      return reply.send({ session: updated, joinToken })
    })
  })

  app.post('/agent/sessions/:id/end', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (session.state === 'ended') return reply.send({ session })
      const wasLive = LIVE_SESSION_STATES.has(session.state)
      const updated = (
        await client.query(
          `UPDATE remote_sessions SET state = 'ended', ended_at = COALESCE(ended_at, now()), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id],
        )
      ).rows[0]
      if (wasLive) app.metrics.sessionTerminated()
      await addSessionEvent(client, ctx.tenantId, id, 'session.agent_ended', 'agent', ctx.deviceId)
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.ended', 'Remote session ended by the endpoint.', 'agent', ctx.deviceId)
      await client.query(
        `UPDATE devices
            SET agent_token_hash = CASE WHEN adhoc THEN NULL ELSE agent_token_hash END,
                agent_token_expires_at = CASE WHEN adhoc THEN now() ELSE agent_token_expires_at END,
                updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [ctx.deviceId, ctx.tenantId],
      )
      await client.query("UPDATE adhoc_sessions SET state = 'ended', updated_at = now() WHERE remote_session_id = $1 AND state = 'claimed'", [id])
      return reply.send({ session: updated })
    })
  })

  app.post('/agent/sessions/:id/events', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = controlAuditSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state, permissions FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (!['connecting', 'active', 'reconnecting'].includes(session.state)) {
        throw AppError.conflict('Session is not accepting control events', 'invalid_session_state')
      }
      if (body.outcome === 'accepted' && body.action === 'unknown') {
        throw AppError.badRequest('Accepted input events require a supported action', 'invalid_input_action')
      }
      if (body.outcome === 'accepted' && ['clipboard_get', 'clipboard_set'].includes(body.action) && !session.permissions.includes('clipboard')) {
        throw AppError.forbidden('Session does not grant clipboard access', 'clipboard_not_allowed')
      }
      if (body.outcome === 'accepted' && ['terminal_start', 'terminal_input', 'terminal_close'].includes(body.action) && !session.permissions.includes('terminal')) {
        throw AppError.forbidden('Session does not grant terminal access', 'terminal_not_allowed')
      }
      if (body.outcome === 'accepted' && ['file_list', 'file_download', 'file_upload'].includes(body.action) && !session.permissions.includes('file_transfer')) {
        throw AppError.forbidden('Session does not grant file transfer', 'file_transfer_not_allowed')
      }
      if (body.outcome === 'accepted' && ['process_list', 'process_terminate', 'service_list', 'service_start', 'service_stop'].includes(body.action) && !session.permissions.includes('system_manage')) {
        throw AppError.forbidden('Session does not grant process/service management', 'system_manage_not_allowed')
      }
      if (body.outcome === 'accepted' && !['clipboard_get', 'clipboard_set', 'terminal_start', 'terminal_input', 'terminal_close', 'file_list', 'file_download', 'file_upload', 'process_list', 'process_terminate', 'service_list', 'service_start', 'service_stop'].includes(body.action) && !session.permissions.includes('control_input')) {
        throw AppError.forbidden('Session does not grant input control', 'control_not_allowed')
      }
      await addSessionEvent(
        client,
        ctx.tenantId,
        id,
        controlAuditEvent(body),
        'agent',
        ctx.deviceId,
        controlAuditPayload(body),
      )
      return reply.code(201).send({ recorded: true })
    })
  })

  app.post('/agent/sessions/:id/messages', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = messageSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (!['connecting', 'active', 'reconnecting'].includes(session.state)) {
        throw AppError.conflict('Session is no longer accepting messages', 'invalid_session_state')
      }
      const message = (
        await client.query(
          `INSERT INTO session_messages (tenant_id, session_id, sender_type, sender_id, body)
           VALUES ($1, $2, 'agent', $3, $4) RETURNING id, sender_type, sender_id, body, created_at`,
          [ctx.tenantId, id, ctx.deviceId, body.body],
        )
      ).rows[0]
      await addSessionEvent(client, ctx.tenantId, id, 'session.chat.sent', 'agent', ctx.deviceId, { chars: body.body.length })
      await appendTicketTimeline(client, ctx.tenantId, id, 'session.chat.sent', `Chat (endpoint): ${body.body}`, 'agent', ctx.deviceId)
      return reply.code(201).send({ message })
    })
  })

  app.post('/agent/sessions/:id/recording', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = recordingStateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (!['connecting', 'active', 'reconnecting'].includes(session.state)) {
        throw AppError.conflict('Session is not accepting recording events', 'invalid_session_state')
      }
      const event = body.state === 'recording' ? 'session.recording.started' : body.state === 'stopped' ? 'session.recording.stopped' : 'session.recording.failed'
      await addSessionEvent(client, ctx.tenantId, id, event, 'agent', ctx.deviceId, body.reason ? { reason: body.reason } : {})
      return reply.code(201).send({ recorded: true })
    })
  })

  app.post('/agent/sessions/:id/diagnostics', { preHandler: [authenticateAgent] }, async (request, reply) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = agentDiagnosticSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT id, state FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      if (['ended', 'denied', 'expired'].includes(session.state)) {
        throw AppError.conflict('Session is no longer accepting diagnostics', 'invalid_session_state')
      }
      await addSessionEvent(client, ctx.tenantId, id, `session.${body.event}`, 'agent', ctx.deviceId, body.reason ? { reason: body.reason } : {})
      return reply.code(201).send({ recorded: true })
    })
  })

  app.post('/agent/sessions/:id/state', { preHandler: [authenticateAgent] }, async (request) => {
    const ctx = request.deviceCtx!
    const { id } = request.params as { id: string }
    const body = agentStateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const session = (await client.query('SELECT * FROM remote_sessions WHERE id = $1 AND device_id = $2', [id, ctx.deviceId])).rows[0]
      if (!session) throw AppError.notFound('Session not found')
      const wasLive = LIVE_SESSION_STATES.has(session.state)
      const updated = (
        await client.query(
          `UPDATE remote_sessions
              SET state = $2,
                  started_at = CASE WHEN $2 = 'active' THEN COALESCE(started_at, now()) ELSE started_at END,
                  ended_at = CASE WHEN $2 = 'ended' THEN COALESCE(ended_at, now()) ELSE ended_at END,
                  updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, body.state],
        )
      ).rows[0]
      if (body.state === 'ended' && wasLive) app.metrics.sessionTerminated()
      await addSessionEvent(client, ctx.tenantId, id, `session.${body.state}`, 'agent', ctx.deviceId)
      if (body.state === 'active') {
        await appendTicketTimeline(client, ctx.tenantId, id, 'session.active', 'Remote session connected.', 'agent', ctx.deviceId)
        if (session.requested_by) {
          await notify(client, ctx.tenantId, {
            userId: session.requested_by,
            kind: 'session_invite',
            body: 'Remote session is now active. The relay connection is ready.',
            subjectType: 'session',
            subjectId: id,
          })
        }
      } else if (body.state === 'ended') {
        await appendTicketTimeline(client, ctx.tenantId, id, 'session.ended', 'Remote session ended.', 'agent', ctx.deviceId)
        await client.query(
          `UPDATE devices
              SET agent_token_hash = CASE WHEN adhoc THEN NULL ELSE agent_token_hash END,
                  agent_token_expires_at = CASE WHEN adhoc THEN now() ELSE agent_token_expires_at END,
                  updated_at = now()
            WHERE id = $1 AND tenant_id = $2`,
          [ctx.deviceId, ctx.tenantId],
        )
        await client.query("UPDATE adhoc_sessions SET state = 'ended', updated_at = now() WHERE remote_session_id = $1 AND state = 'claimed'", [id])
      }
      return { session: updated }
    })
  })
}
