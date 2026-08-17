import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import {
  bridgeIncident,
  declareIncident,
  getIncident,
  INCIDENT_STATUSES,
  listIncidents,
  SEVERITIES,
  updateIncident,
} from './incidents.js'
import '../../types.js'

const declareSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  description: z.string().max(20_000).optional(),
  severity: z.enum(SEVERITIES).optional(),
  commanderId: z.string().min(1).optional(),
})

const updateSchema = z.object({
  severity: z.enum(SEVERITIES).optional(),
  status: z.enum(INCIDENT_STATUSES).optional(),
  commanderId: z.string().min(1).nullable().optional(),
})

const bridgeSchema = z.object({
  targetTicketId: z.string().min(1),
})

export async function incidentRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('incident.read')]
  const manage = [authenticate, requireTenant, requirePermission('incident.manage')]

  app.post('/incidents', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = declareSchema.parse(request.body)
    const result = await declareIncident(app.db, ctx.tenantId, request.user!.id, body)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'incident.declared',
        objectType: 'major_incident',
        objectId: (result.ticketId as string) ?? null,
        ip: request.ip,
        payload: { severity: body.severity ?? 'sev3', subject: body.subject },
      })
    })
    return reply.code(201).send(result)
  })

  app.get('/incidents', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { status, severity } = request.query as Record<string, string | undefined>
    const incidents = await listIncidents(app.db, ctx.tenantId, {
      status: status as (typeof INCIDENT_STATUSES)[number] | undefined,
      severity: severity as (typeof SEVERITIES)[number] | undefined,
    })
    return { incidents }
  })

  app.get('/incidents/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return getIncident(app.db, ctx.tenantId, id)
  })

  app.patch('/incidents/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    const incident = await updateIncident(app.db, ctx.tenantId, id, body)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'incident.updated',
        objectType: 'major_incident',
        objectId: id,
        ip: request.ip,
        payload: { ...body, commanderId: body.commanderId ?? null },
      })
    })
    return { incident }
  })

  app.post('/incidents/:id/bridge', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = bridgeSchema.parse(request.body)
    const result = await bridgeIncident(app.db, ctx.tenantId, id, body.targetTicketId)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'incident.bridged',
        objectType: 'major_incident',
        objectId: id,
        ip: request.ip,
        payload: { targetTicketId: body.targetTicketId },
      })
    })
    return reply.code(201).send(result)
  })
}
