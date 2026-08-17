import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const
const STATUSES = ['ringing', 'answered', 'missed', 'completed', 'failed'] as const

const createCallSchema = z.object({
  direction: z.enum(DIRECTIONS),
  fromNumber: z.string().max(40).optional(),
  toNumber: z.string().max(40).optional(),
  status: z.enum(STATUSES).optional(),
  callerName: z.string().max(120).optional(),
  startedAt: z.string().optional(),
  durationSec: z.number().int().min(0).optional(),
  ticketId: z.string().min(1).optional(),
  providerCallId: z.string().max(200).optional(),
  recordingRef: z.string().max(500).optional(),
  ext: z.record(z.unknown()).optional(),
})

const linkCallSchema = z.object({
  ticketId: z.string().min(1).nullable(),
})

export async function telephonyRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('telephony.read')]
  const manage = [authenticate, requireTenant, requirePermission('telephony.manage')]

  app.get('/telephony/calls', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { ticketId, direction, status, q } = request.query as Record<string, string | undefined>
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const where: string[] = []
      const params: unknown[] = []
      if (ticketId) {
        params.push(ticketId)
        where.push(`c.ticket_id = $${params.length}`)
      }
      if (direction) {
        params.push(direction)
        where.push(`c.direction = $${params.length}`)
      }
      if (status) {
        params.push(status)
        where.push(`c.status = $${params.length}`)
      }
      if (q) {
        params.push(`%${q}%`)
        where.push(
          `(c.from_number ILIKE $${params.length} OR c.to_number ILIKE $${params.length} OR c.caller_name ILIKE $${params.length})`,
        )
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const { rows } = await client.query(
        `SELECT c.*, t.number AS ticket_number, t.subject AS ticket_subject
           FROM call_logs c
           LEFT JOIN tickets t ON t.id = c.ticket_id
           ${whereSql}
          ORDER BY c.started_at DESC
          LIMIT 200`,
        params,
      )
      return { calls: rows }
    })
  })

  app.get('/telephony/calls/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.*, t.number AS ticket_number, t.subject AS ticket_subject
           FROM call_logs c
           LEFT JOIN tickets t ON t.id = c.ticket_id
          WHERE c.id = $1`,
        [id],
      )
      if (!rows[0]) throw AppError.notFound('Call not found')
      return { call: rows[0] }
    })
  })

  app.post('/telephony/calls', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createCallSchema.parse(request.body)
    const call = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.ticketId) {
        const ticket = (await client.query('SELECT id FROM tickets WHERE id = $1', [body.ticketId])).rows[0]
        if (!ticket) throw AppError.notFound('Ticket not found')
      }
      const { rows } = await client.query(
        `INSERT INTO call_logs
           (tenant_id, direction, from_number, to_number, status, caller_name, started_at,
            duration_sec, ticket_id, provider_call_id, recording_ref, ext)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING *`,
        [
          ctx.tenantId,
          body.direction,
          body.fromNumber ?? '',
          body.toNumber ?? '',
          body.status ?? 'completed',
          body.callerName ?? null,
          body.startedAt ?? new Date(),
          body.durationSec ?? 0,
          body.ticketId ?? null,
          body.providerCallId ?? null,
          body.recordingRef ?? null,
          JSON.stringify(body.ext ?? {}),
        ],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'telephony.call_logged',
        objectType: 'call_log',
        objectId: rows[0].id,
        ip: request.ip,
        payload: { direction: body.direction, ticketId: body.ticketId ?? null },
      })
      return rows[0]
    })
    return reply.code(201).send({ call })
  })

  app.patch('/telephony/calls/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = linkCallSchema.parse(request.body)
    const call = await withTenant(app.db, ctx.tenantId, async (client) => {
      const existing = (await client.query('SELECT id FROM call_logs WHERE id = $1', [id])).rows[0]
      if (!existing) throw AppError.notFound('Call not found')
      if (body.ticketId) {
        const ticket = (await client.query('SELECT id FROM tickets WHERE id = $1', [body.ticketId])).rows[0]
        if (!ticket) throw AppError.notFound('Ticket not found')
      }
      const { rows } = await client.query('UPDATE call_logs SET ticket_id = $2 WHERE id = $1 RETURNING *', [id, body.ticketId])
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'telephony.call_linked',
        objectType: 'call_log',
        objectId: id,
        ip: request.ip,
        payload: { ticketId: body.ticketId },
      })
      return rows[0]
    })
    return { call }
  })
}
